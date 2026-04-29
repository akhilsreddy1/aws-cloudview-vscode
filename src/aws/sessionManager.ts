import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromIni } from "@aws-sdk/credential-providers";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type * as vscode from "vscode";
import type { AwsProfileSession, Logger } from "../core/contracts";
import { getSharedNodeHttpHandler } from "./sharedNodeHttpHandler";

interface AwsProfileMetadata {
  name: string;
  region?: string;
}

const SELECTED_PROFILES_KEY = "cloudView.selectedProfiles";
const SELECTED_REGIONS_KEY = "cloudView.selectedRegions";

/**
 * Manages AWS CLI profile discovery, credential resolution, and user
 * selections (active profiles and regions).
 *
 * Profile metadata is parsed directly from `~/.aws/config` and
 * `~/.aws/credentials` at startup and cached in memory. Resolved
 * {@link AwsProfileSession} objects (including the caller-identity account ID)
 * are also cached to avoid repeated STS calls during a single session.
 *
 * User selections (active profiles and regions) are persisted to VS Code
 * global state so they survive extension restarts.
 */
export class SessionManager {
  private readonly sessionCache = new Map<string, AwsProfileSession>();
  private readonly profileMetadata = new Map<string, AwsProfileMetadata>();

  public constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly getConfiguredRegionsInternal: () => string[]
  ) {}

  /**
   * Parses `~/.aws/config` and `~/.aws/credentials` to enumerate available
   * profile names and their default regions. Results are sorted alphabetically.
   * Subsequent calls return the in-memory cache.
   */
  public async listProfiles(): Promise<AwsProfileMetadata[]> {
    if (this.profileMetadata.size > 0) {
      return Array.from(this.profileMetadata.values()).sort((left, right) => left.name.localeCompare(right.name));
    }

    const configPath = process.env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
    const credentialsPath =
      process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), ".aws", "credentials");

    this.logger.info(`Reading AWS profiles from config=${configPath} credentials=${credentialsPath}`);

    const configProfiles = await this.readAwsIni(configPath, true);
    const credentialProfiles = await this.readAwsIni(credentialsPath, false);

    for (const [name, region] of [...configProfiles, ...credentialProfiles]) {
      const existing = this.profileMetadata.get(name);
      this.profileMetadata.set(name, {
        name,
        region: existing?.region ?? region
      });
    }

    return Array.from(this.profileMetadata.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Drops cached `resolveProfile` results. Call when proxy/HTTP settings change so
   * the next resolution rebuilds the ini credential provider with a fresh
   * `clientConfig.requestHandler` (inner STS/SSO use the new proxy).
   */
  public clearResolvedSessions(): void {
    this.sessionCache.clear();
  }

  /**
   * Clears cached profile metadata and resolved sessions. Call this to force
   * `listProfiles()` to re-read `~/.aws/config` and `~/.aws/credentials` and
   * pick up any newly added profiles.
   */
  public refreshProfiles(): void {
    this.profileMetadata.clear();
    this.sessionCache.clear();
  }

  /**
   * Returns the user's currently-selected profile names, reconciled against
   * the live contents of `~/.aws/config` / `~/.aws/credentials`. Selections
   * that no longer exist in the ini files (renamed or deleted profiles) are
   * dropped from globalState so the next discovery doesn't try to resolve a
   * profile that AWS can't find.
   *
   */
  public async getSelectedProfiles(): Promise<string[]> {
    const stored = this.extensionContext.globalState.get<string[]>(SELECTED_PROFILES_KEY, []);
    if (stored.length === 0) return stored;

    const available = new Set((await this.listProfiles()).map((p) => p.name));
    const reconciled = stored.filter((name) => available.has(name));
    if (reconciled.length !== stored.length) {
      const removed = stored.filter((name) => !available.has(name));
      this.logger.warn(
        `Dropping ${removed.length} stale selected profile(s) no longer present in AWS config: ${removed.join(", ")}`
      );
      // Also evict any cached sessions for the now-gone profiles, just in case
      // they were resolved earlier in this VS Code window.
      for (const name of removed) this.sessionCache.delete(name);
      await this.extensionContext.globalState.update(SELECTED_PROFILES_KEY, reconciled);
    }
    return reconciled;
  }

  public async setSelectedProfiles(profileNames: string[]): Promise<void> {
    await this.extensionContext.globalState.update(SELECTED_PROFILES_KEY, profileNames);
  }

  /**
   * Resolves credentials for `profileName` via `@aws-sdk/credential-providers`
   * and calls STS `GetCallerIdentity` to determine the account ID.
   * The resulting session is cached; subsequent calls for the same profile
   * return the cached session without making another STS call.
   *
   * @throws if STS fails to return an account ID.
   */
  public async resolveProfile(profileName: string): Promise<AwsProfileSession> {
    const cached = this.sessionCache.get(profileName);
    if (cached) {
      return cached;
    }

    const profiles = await this.listProfiles();
    const metadata = profiles.find((profile) => profile.name === profileName);
    const requestHandler = getSharedNodeHttpHandler(this.logger);
    // Inner STS/SSO/signin clients used by the ini chain (assume-role, SSO, web identity) pick up
    // the same proxy/SSL behavior as our service clients — see `FromIniInit.clientConfig`.
    const credentials = fromIni({
      profile: profileName,
      clientConfig: { requestHandler },
    });
    const stsClient = new STSClient({
      region: metadata?.region ?? "us-east-1",
      credentials,
      requestHandler,
    });

    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    if (!accountId) {
      throw new Error(`Unable to resolve AWS account for profile ${profileName}`);
    }

    const session: AwsProfileSession = {
      profileName,
      accountId,
      credentials,
      defaultRegion: metadata?.region
    };

    this.sessionCache.set(profileName, session);
    this.logger.info(`Resolved AWS session for profile ${profileName} (${accountId})`);
    return session;
  }

  /**
   * Returns resolved sessions for all currently selected profiles.
   *
   * Failures are isolated per profile — a single broken profile (expired SSO,
   * network glitch, missing role) no longer breaks discovery for the rest.
   * Failures are logged and surfaced once via the warning channel; callers
   * proceed with the working subset.
   */
  public async getSelectedProfileSessions(): Promise<AwsProfileSession[]> {
    const selected = await this.getSelectedProfiles();
    const settled = await Promise.allSettled(selected.map((p) => this.resolveProfile(p)));
    const sessions: AwsProfileSession[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        sessions.push(result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.warn(`Failed to resolve profile "${selected[i]}": ${message}`);
      }
    }
    return sessions.sort((left, right) => left.profileName.localeCompare(right.profileName));
  }

  /**
   * Looks up a profile name by AWS account ID across all currently selected
   * and resolved sessions. Returns `undefined` if no session matches.
   */
  public async findProfileNameByAccountId(accountId: string): Promise<string | undefined> {
    const sessions = await this.getSelectedProfileSessions();
    return sessions.find((session) => session.accountId === accountId)?.profileName;
  }

  public getConfiguredRegions(): string[] {
    return this.getConfiguredRegionsInternal();
  }

  public async getSelectedRegions(): Promise<string[]> {
    const persisted = this.extensionContext.globalState.get<string[]>(SELECTED_REGIONS_KEY);
    if (persisted && persisted.length > 0) {
      return persisted;
    }
    return this.getConfiguredRegionsInternal().filter((r) => r !== "global");
  }

  public async setSelectedRegions(regions: string[]): Promise<void> {
    await this.extensionContext.globalState.update(SELECTED_REGIONS_KEY, regions);
  }

  public async toggleRegion(region: string): Promise<string[]> {
    const current = await this.getSelectedRegions();
    const next = current.includes(region)
      ? current.filter((r) => r !== region)
      : [...current, region];
    await this.setSelectedRegions(next);
    return next;
  }

  public async toggleProfile(profileName: string): Promise<string[]> {
    const current = await this.getSelectedProfiles();
    const next = current.includes(profileName)
      ? current.filter((p) => p !== profileName)
      : [...current, profileName];
    await this.setSelectedProfiles(next);
    return next;
  }

  private async readAwsIni(filePath: string, isConfigFile: boolean): Promise<Map<string, string | undefined>> {
    const profiles = new Map<string, string | undefined>();

    try {
      let raw = await fs.readFile(filePath, "utf8");
      // Strip a UTF-8 BOM if present. Windows Notepad writes BOM by default,
      // and `String.prototype.trim()` doesn't always strip it across Node
      // versions — leaving the first `[profile]` header un-matchable and
      // silently dropping the first profile.
      if (raw.charCodeAt(0) === 0xfeff) {
        raw = raw.slice(1);
      }
      let currentProfile: string | undefined;

      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
          continue;
        }

        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
          let name = sectionMatch[1].trim();
          if (isConfigFile && name.startsWith("profile ")) {
            name = name.slice("profile ".length);
          }

          currentProfile = name;
          if (!profiles.has(name)) {
            profiles.set(name, undefined);
          }
          continue;
        }

        if (currentProfile) {
          const [rawKey, ...rawValueParts] = trimmed.split("=");
          if (!rawKey || rawValueParts.length === 0) {
            continue;
          }

          const key = rawKey.trim();
          const value = rawValueParts.join("=").trim();
          if (key === "region" && value) {
            profiles.set(currentProfile, value);
          }
        }
      }
    } catch (error) {
      // ENOENT is expected if the user only has one of {config, credentials}
      // — log at debug level rather than warn, since an empty profile list is
      // only really a problem if BOTH files are missing/unreadable.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.logger.info(`AWS profile file not present at ${filePath} (skipping)`);
      } else {
        this.logger.warn(
          `Unable to read AWS profile file ${filePath} (${code ?? "unknown error"}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (profiles.size > 0) {
      this.logger.info(`Parsed ${profiles.size} profile(s) from ${filePath}: ${Array.from(profiles.keys()).join(", ")}`);
    }

    return profiles;
  }
}
