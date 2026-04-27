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

    const configProfiles = await this.readAwsIni(path.join(os.homedir(), ".aws", "config"), true);
    const credentialProfiles = await this.readAwsIni(path.join(os.homedir(), ".aws", "credentials"), false);

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

  public async getSelectedProfiles(): Promise<string[]> {
    return this.extensionContext.globalState.get<string[]>(SELECTED_PROFILES_KEY, []);
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
   * Profiles that fail to resolve are propagated as rejections.
   */
  public async getSelectedProfileSessions(): Promise<AwsProfileSession[]> {
    const selected = await this.getSelectedProfiles();
    const sessions = await Promise.all(selected.map((profileName) => this.resolveProfile(profileName)));
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
      const raw = await fs.readFile(filePath, "utf8");
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
      this.logger.warn(`Unable to read AWS profile file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return profiles;
  }
}
