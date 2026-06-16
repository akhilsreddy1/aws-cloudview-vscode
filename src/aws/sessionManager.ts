import { fromIni } from "@aws-sdk/credential-providers";
import {
  STSClient,
  GetCallerIdentityCommand,
  getDefaultRoleAssumer,
  getDefaultRoleAssumerWithWebIdentity,
} from "@aws-sdk/client-sts";
import type * as vscode from "vscode";
import type { AwsProfileSession, Logger } from "../core/contracts";
import { parseMergedAwsIniLikeSdk } from "./mergedAwsIni";
import { getSharedNodeHttpHandler } from "./sharedNodeHttpHandler";

interface AwsProfileMetadata {
  name: string;
  region?: string;
}

/**
 * Resolved file paths that BOTH our enumerator and the AWS SDK's `fromIni`
 * read from. Empty string falls back to env vars, then SDK defaults.
 */
export interface AwsIniPaths {
  /** Path to `~/.aws/config` (or override). Empty = use env / default. */
  configFilePath?: string;
  /** Path to `~/.aws/credentials` (or override). Empty = use env / default. */
  credentialsFilePath?: string;
}

/**
 * Convert an SDK / STS error into a user-friendly, actionable message.
 *
 * The SDK's default `Could not load credentials from any providers` /
 * `ExpiredToken` / `InvalidClientTokenId` are accurate but unhelpful when
 * surfaced raw in a notification — users have to know what each one means.
 * This function maps the common shapes to specific next-step text the user
 * can follow without leaving the editor.
 */
function classifyResolveError(profileName: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const lower = `${name} ${raw}`.toLowerCase();

  if (lower.includes("expiredtoken") || lower.includes("token included in the request is expired") || lower.includes("session token") && lower.includes("expired")) {
    return `Profile "${profileName}" has expired credentials. Re-auth (e.g. \`aws sso login --profile ${profileName}\`), then click "CloudView: Reload AWS Profiles".`;
  }
  // AWS SSO OIDC commonly surfaces as generic unauthorized / forbidden after cache expiry.
  if (
    lower.includes("unauthorized_exception") ||
    lower.includes("forbidden_exception") ||
    (lower.includes("sso") &&
      (lower.includes("authorize") ||
        lower.includes("authorise") ||
        lower.includes("not authorized") ||
        lower.includes("login") ||
        lower.includes("grant")))
  ) {
    return `Profile "${profileName}" may need SSO re-login. Try \`aws sso login --profile ${profileName}\`, run \`aws sts get-caller-identity --profile ${profileName}\` from a terminal, then click "CloudView: Reload AWS Profiles". If you use assume-role chained off SSO, re-auth the base profile too.`;
  }
  if (lower.includes("invalidclienttoken") || lower.includes("security token included in the request is invalid")) {
    return `Profile "${profileName}" has invalid AWS keys (likely rotated or deactivated in IAM). Update them in your credentials file, then click "CloudView: Reload AWS Profiles".`;
  }

  // ── Assume-role-specific failures ─────────────────────────────────────
  // These come from STS:AssumeRole calls that fromIni makes when the
  // profile has `role_arn` + `source_profile` (or `web_identity_token_file`).
  if (lower.includes("accessdenied") && (lower.includes("assumerole") || lower.includes("sts:assumerole"))) {
    return `Profile "${profileName}" cannot assume its role: AccessDenied. Check that the role's trust policy allows the source profile / your IAM user, and that you have \`sts:AssumeRole\` on the target role.`;
  }
  if (lower.includes("could not find source credentials") || (lower.includes("source_profile") && lower.includes("not found"))) {
    const raw_match = raw.match(/source_profile[^a-z0-9_]*([a-z0-9_-]+)/i);
    const sp = raw_match?.[1] ?? "<source_profile>";
    return `Profile "${profileName}" references source_profile "${sp}", but that profile isn't resolvable. Make sure [${sp}] (in credentials) or [profile ${sp}] (in config) exists with valid keys.`;
  }
  if (lower.includes("invalidparametervalue") && lower.includes("role_arn")) {
    return `Profile "${profileName}" has a malformed \`role_arn\`. Expected format: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME.`;
  }
  if (lower.includes("could not load credentials from any providers") || lower.includes("credentialsnotfound")) {
    return `Profile "${profileName}" has no usable credentials. Check that \`aws_access_key_id\` and \`aws_secret_access_key\` are set under [${profileName}] in your credentials file, OR that assume-role config sits in \`~/.aws/config\` (not in credentials).`;
  }
  if (lower.includes("could not resolve credentials using profile")) {
    return `Profile "${profileName}" was found in the ini files but the SDK couldn't resolve it. If it uses assume-role/SSO, that config must live in \`~/.aws/config\` (not credentials). Run \`aws sts get-caller-identity --profile ${profileName}\` to confirm the AWS CLI can use it.`;
  }
  if (lower.includes("profile") && (lower.includes("not found") || lower.includes("does not exist"))) {
    return `Profile "${profileName}" is selected in CloudView but not found in your AWS ini files. Open "CloudView: Select AWS Profiles" and re-pick.`;
  }
  if (lower.includes("getaddrinfo") || lower.includes("connect etimedout") || lower.includes("network") || lower.includes("enotfound")) {
    return `Network error resolving profile "${profileName}": ${raw}. If you're behind a corporate proxy, set \`HTTPS_PROXY\` env var or \`cloudView.proxy.url\` and reload the window.`;
  }
  if (lower.includes("mfa")) {
    return `Profile "${profileName}" requires MFA. CloudView's credential chain doesn't prompt for tokens — run \`aws sts get-caller-identity --profile ${profileName}\` once in a terminal to populate the cached MFA session, then retry here.`;
  }
  return `Failed to resolve profile "${profileName}": ${raw}`;
}

const SELECTED_PROFILES_KEY = "cloudView.selectedProfiles";
const SELECTED_REGIONS_KEY = "cloudView.selectedRegions";

/** One selected profile CloudView couldn't resolve via STS/`fromIni`. */
export interface ProfileCredentialIssue {
  profileName: string;
  /** Actionable explanation (often includes SSO / proxy hints). */
  message: string;
}

export interface SelectedProfilesResolutionSummary {
  sessions: AwsProfileSession[];
  credentialFailures: ProfileCredentialIssue[];
}

/**
 * Manages AWS CLI profile discovery, credential resolution, and user
 * selections (active profiles and regions).
 *
 * Profile names and regions come from `@smithy/shared-ini-file-loader`'s merged
 * config (same inputs as `@aws-sdk` `fromIni`). Resolved
 * {@link AwsProfileSession} objects (including the caller-identity account ID)
 * are also cached to avoid repeated STS calls during a single session.
 *
 * User selections (active profiles and regions) are persisted to VS Code
 * global state so they survive extension restarts.
 */
export class SessionManager {
  private readonly sessionCache = new Map<string, AwsProfileSession>();
  private readonly profileMetadata = new Map<string, AwsProfileMetadata>();
  /** When true, the next `listProfiles` scan reloads shared ini from disk (used after `refreshProfiles`). */
  private reloadMergedIniOnNextScan = false;

  public constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly getConfiguredRegionsInternal: () => string[],
    /**
     * Live getter for AWS ini file paths. Read on every `listProfiles` /
     * `resolveProfile` so toggling the setting takes effect on the next
     * "Reload AWS Profiles" without an extension restart. Either field
     * may be empty/undefined; downstream handles the fallback chain.
     */
    private readonly getAwsIniPaths: () => AwsIniPaths = () => ({})
  ) {}

  /**
   * Enumerates credential profiles (`AWS_*` paths and merges match the SDK ini chain).
   * Results are sorted alphabetically. Subsequent calls return the in-memory cache.
   */
  public async listProfiles(): Promise<AwsProfileMetadata[]> {
    if (this.profileMetadata.size > 0) {
      return Array.from(this.profileMetadata.values()).sort((left, right) => left.name.localeCompare(right.name));
    }

    const paths = this.getAwsIniPaths();
    if (paths.configFilePath) {
      this.logger.info(`Using explicit AWS config path: ${paths.configFilePath}`);
    }
    if (paths.credentialsFilePath) {
      this.logger.info(`Using explicit AWS credentials path: ${paths.credentialsFilePath}`);
    }
    // Same merge rules as `fromIni`, plus UTF-8 BOM stripping so the first `[profile]` on Windows is not dropped.
    const merged = await parseMergedAwsIniLikeSdk({
      ignoreCache: this.reloadMergedIniOnNextScan,
      configFilepath: paths.configFilePath || undefined,
      filepath: paths.credentialsFilePath || undefined,
    });
    this.reloadMergedIniOnNextScan = false;
    const profileNames = Object.keys(merged).filter((k) => this.isSelectableProfileKey(k));
    this.logger.info(`Listed ${profileNames.length} AWS credential profile(s): ${profileNames.join(", ") || "(none)"}`);

    for (const [name, section] of Object.entries(merged)) {
      if (!this.isSelectableProfileKey(name)) {
        continue;
      }
      const region = section?.region?.trim() || undefined;
      this.profileMetadata.set(name, { name, region });
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
    this.reloadMergedIniOnNextScan = true;
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
    const paths = this.getAwsIniPaths();

    // Inner-client config used by every assumed-role / SSO / web-identity
    // STS call that fromIni makes on our behalf. Sharing the requestHandler
    // means assume-role traffic goes through the same proxy + SSL settings
    // as our service clients.
    const innerClientConfig = { requestHandler };

    // Pass explicit ini paths so `fromIni` reads the same files our enumerator
    // listed from. Without this, the SDK falls back to its own defaults and
    // can disagree with us on Windows / corp setups where AWS_CONFIG_FILE
    // points elsewhere — symptom: "Could not resolve credentials using profile"
    // even though our list shows the profile.
    //
    // Pass `roleAssumer` / `roleAssumerWithWebIdentity` so profiles that use
    // `role_arn` + `source_profile` (or `web_identity_token_file`) actually
    // resolve. Without these, fromIni rejects assume-role chains with the
    // generic "Could not resolve credentials" — the SDK doesn't bundle a
    // default STS-backed assumer to avoid a hard dependency on @aws-sdk/client-sts
    // inside the credential package.
    const credentials = fromIni({
      profile: profileName,
      filepath: paths.credentialsFilePath || undefined,
      configFilepath: paths.configFilePath || undefined,
      clientConfig: innerClientConfig,
      roleAssumer: getDefaultRoleAssumer(innerClientConfig),
      roleAssumerWithWebIdentity: getDefaultRoleAssumerWithWebIdentity(innerClientConfig),
    });
    const stsClient = new STSClient({
      region: metadata?.region ?? "us-east-1",
      credentials,
      requestHandler,
    });

    let identity;
    try {
      identity = await stsClient.send(new GetCallerIdentityCommand({}));
    } catch (err: unknown) {
      // Translate raw SDK errors into actionable messages before re-throwing,
      // so the warning in `getSelectedProfileSessions` carries useful text.
      throw new Error(classifyResolveError(profileName, err));
    }
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
   * Resolves all selected profiles in parallel without failing the aggregate.
   * Use this when you want both usable sessions AND per-profile STS errors for UI.
   */
  public async summarizeSelectedProfileSessions(): Promise<SelectedProfilesResolutionSummary> {
    const selected = await this.getSelectedProfiles();
    const settled = await Promise.allSettled(selected.map((p) => this.resolveProfile(p)));
    const sessions: AwsProfileSession[] = [];
    const credentialFailures: ProfileCredentialIssue[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        sessions.push(result.value);
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason ?? "Unknown error");
        credentialFailures.push({ profileName: selected[i], message });
      }
    }
    sessions.sort((left, right) => left.profileName.localeCompare(right.profileName));
    return { sessions, credentialFailures };
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
    const { sessions, credentialFailures } = await this.summarizeSelectedProfileSessions();
    for (const failure of credentialFailures) {
      // `classifyResolveError` already produced a complete message (often SSO / proxy hints).
      this.logger.warn(failure.message);
    }
    return sessions;
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

  /** Keys emitted for non-profile ini sections merged into the same map (same as `@aws-sdk` ini chain). */
  private isSelectableProfileKey(key: string): boolean {
    if (key.startsWith("sso-session.") || key === "sso-session") return false;
    if (key.startsWith("services.") || key === "services") return false;
    return true;
  }
}
