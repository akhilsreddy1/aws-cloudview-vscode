import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { CloudViewPlatform } from "./platform";

/** Sentinel region string used for globally-scoped resources (e.g. IAM, S3 bucket listings). */
export const GLOBAL_REGION = "global";

/** A flat string-to-string map of AWS resource tags. */
export type TagMap = Record<string, string>;
/** A generic JSON-compatible object used for raw API response storage. */
export type JsonRecord = Record<string, unknown>;
/** Whether a resource type is scoped to a single region or is account-global. */
export type ResourceScope = "regional" | "global";

/**
 * Identifies the exact AWS execution context for a discovery or resolver operation:
 * the named CLI profile, resolved account ID, and target region.
 */
export interface AwsScope {
  profileName: string;
  accountId: string;
  region: string;
}

/**
 * A resolved AWS profile session, including the SDK credential provider
 * and the resolved account ID for the profile.
 */
export interface AwsProfileSession {
  profileName: string;
  accountId: string;
  credentials: AwsCredentialIdentityProvider;
  defaultRegion?: string;
}

/**
 * The canonical in-memory and on-disk representation of a discovered AWS resource.
 * Every resource is uniquely identified by its `arn`; `rawJson` holds the
 * unmodified AWS API response for use in detail panels.
 */
export interface ResourceNode {
  arn: string;
  id: string;
  type: string;
  service: string;
  accountId: string;
  region: string;
  name: string;
  tags: TagMap;
  rawJson: JsonRecord;
  /** Unix epoch milliseconds of the last successful discovery run. */
  lastUpdated: number;
}

/**
 * A directed relationship between two {@link ResourceNode} objects.
 * The `relationshipType` is a human-readable string such as `"uses-vpc"` or
 * `"triggers"` that describes the nature of the connection.
 */
export interface Edge {
  fromArn: string;
  toArn: string;
  relationshipType: string;
  metadataJson: JsonRecord;
  /** Unix epoch milliseconds of the last successful resolution run. */
  lastUpdated: number;
}

/**
 * Tracks the execution state of a single discovery or relationship-resolution
 * task. Persisted in SQLite so TTL decisions survive extension restarts.
 * `scopeKey` is a pipe-delimited composite key:
 * `profileName|accountId|region|resourceType` (or `arn|relationshipType`).
 */
export interface DiscoveryJob {
  scopeKey: string;
  jobType: "resource-discovery" | "relationship-resolution";
  profileName: string;
  accountId: string;
  region: string;
  service: string;
  resourceType: string;
  status: "idle" | "running" | "succeeded" | "failed";
  /** Unix epoch ms of the last completed run. */
  lastRun?: number;
  /** Unix epoch ms before which the job should not be re-run (TTL gate). */
  nextEligibleRun?: number;
  /** Serialized error message from the most recent failed run. */
  error?: string;
  metadataJson: JsonRecord;
}

/**
 * Runtime configuration for the Cloud View extension, sourced from VS Code
 * workspace settings under the `cloudView` namespace.
 */
export interface CloudViewConfiguration {
  /** AWS regions to include in discovery (always includes `"global"`). */
  regions: string[];
  /** Default cache TTL in seconds for resources that don't declare their own. */
  defaultTtlSeconds: number;
  /** Maximum number of concurrent AWS API requests across all services. */
  globalConcurrency: number;
  /** Per-service concurrency overrides keyed by service ID (e.g. `"ec2"`). */
  serviceConcurrency: Record<string, number>;
  /** How many hops to expand by default when opening the graph view. */
  defaultGraphExpandDepth: number;
  /**
   * Maximum wall-clock seconds for a global "Refresh Resources" run. `0`
   * disables the timeout entirely (the default). When set and exceeded,
   * the refresh aborts via the same cancellation path as a user-clicked
   * Cancel button — partial results stay in the cache.
   */
  refreshTimeoutSeconds: number;
}

/** Minimal structured logger interface used throughout the extension. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/**
 * Describes a single field shown in the resource detail panel.
 * `path` is a dot-notation key path into either the `ResourceNode` itself
 * (`source: "resource"`) or its `rawJson` response (`source: "raw"`).
 */
export interface ResourceDetailField {
  label: string;
  path: string;
  source?: "resource" | "raw";
}

/**
 * Complete description of an AWS resource type registered with the platform.
 * Each plugin registers one or more definitions via {@link ResourceRegistry}.
 */
export interface ResourceTypeDefinition {
  /** Unique dot-namespaced type string, e.g. `"aws.ec2.instance"`. */
  type: string;
  /** Short service identifier used for grouping, e.g. `"ec2"`. */
  service: string;
  /** Human-readable service name shown in the tree sidebar. */
  serviceLabel: string;
  /** Human-readable resource type name, e.g. `"EC2 Instance"`. */
  displayName: string;
  scope: ResourceScope;
  /** Cache TTL in seconds specific to this resource type. */
  ttlSeconds: number;
  /** Discoverer function that returns a list of {@link ResourceNode} objects. */
  discoverer: ResourceDiscoverer;
  /** Detail fields to surface in the detail panel for this resource type. */
  detailFields?: ResourceDetailField[];
  /** Tree description function that returns a short description string shown below the resource name in the tree. */
  getTreeDescription?: (resource: ResourceNode) => string | undefined;
  /** Builds the AWS Console deep-link URL for a specific resource instance. */
  buildConsoleUrl?: (resource: ResourceNode) => string | undefined;
  /** Builds a CLI command that describes a specific resource instance. */
  buildCliDescribeCommand?: (resource: ResourceNode) => string | undefined;
}

/** Input passed to a {@link ResourceDiscoverer} for a single discovery run. */
export interface DiscoveryContext {
  scope: AwsScope;
  definition: ResourceTypeDefinition;
  platform: CloudViewPlatform;
  /**
   * Opaque pagination token supplied by the coordinator when resuming a run
   * that previously crashed or was interrupted mid-pagination. Discoverers
   * that support streaming should pass this as the starting marker to their
   * AWS SDK request. May be `undefined` on fresh runs.
   */
  resumeToken?: string;
  /**
   * Cooperative cancellation signal. Wired up from the
   * "Refresh Resources" progress notification's cancel button (see
   * `extension.ts`). Discoverers should check `isCancellationRequested`
   * between pages so a user-cancelled refresh stops promptly instead of
   * running every remaining page to completion. Structurally compatible
   * with `vscode.CancellationToken`.
   */
  cancellation?: { readonly isCancellationRequested: boolean };
  /**
   * Streams a page of discovered resources to the repository immediately.
   * When a discoverer uses this, the coordinator also persists the
   * pagination `nextToken` so the run can resume if interrupted. Discoverers
   * that don't call this still work — the coordinator falls back to bulk
   * persistence of the array returned from `discover()`.
   */
  persistPage(batch: ResourceNode[], nextToken?: string): Promise<void>;
}

/**
 * The result returned by a {@link RelationshipResolver}: newly discovered
 * stub nodes (e.g. target resources that may not yet be cached) and the
 * directed edges connecting them to the source resource.
 */
export interface RelationshipResolution {
  nodes: ResourceNode[];
  edges: Edge[];
}

/** Input passed to a {@link RelationshipResolver} for a single resolution run. */
export interface ResolverContext {
  source: ResourceNode;
  platform: CloudViewPlatform;
}

/**
 * Plugin interface for listing AWS resources of a specific type within a scope.
 * Implementations call the appropriate AWS SDK and return normalized
 * {@link ResourceNode} objects.
 */
export interface ResourceDiscoverer {
  discover(context: DiscoveryContext): Promise<ResourceNode[]>;
}

/**
 * Plugin interface for deriving cross-service relationships from a source
 * resource. Each resolver handles one `relationshipType` for one `sourceType`.
 */
export interface RelationshipResolver {
  id: string;
  /** The resource type this resolver handles, e.g. `"aws.lambda.function"`. */
  sourceType: string;
  /** Label for the directed edge, e.g. `"uses-vpc"`. */
  relationshipType: string;
  /** How long resolved edges are considered fresh before re-resolving. */
  ttlSeconds: number;
  resolve(context: ResolverContext): Promise<RelationshipResolution>;
}

/**
 * A context-menu action that can be performed on a resource from the tree
 * view or resource detail panel. Actions are registered via {@link ActionRegistry}.
 */
export interface ResourceAction {
  id: string;
  /** Label shown in the quick-pick action list. */
  title: string;
  /** Optional sort order; lower values appear first. */
  order?: number;
  /** Returns `true` when this action is applicable to the given resource. */
  isAvailable(resource: ResourceNode, platform: CloudViewPlatform): boolean;
  execute(resource: ResourceNode, platform: CloudViewPlatform): Promise<void>;
}

/** The result of a graph expansion or service-map query from {@link GraphEngine}. */
export interface GraphExpandResult {
  rootArn: string;
  nodes: ResourceNode[];
  edges: Edge[];
}

/** A serializable reference to a {@link ResourceAction} sent to the webview. */
export interface ResourceDetailsActionDescriptor {
  id: string;
  title: string;
}

/** Full payload sent to the resource details webview panel for rendering. */
export interface ResourceDetailsPayload {
  arn: string;
  title: string;
  subtitle: string;
  metadata: Array<{ label: string; value: string }>;
  tags: Array<{ key: string; value: string }>;
  actions: ResourceDetailsActionDescriptor[];
}
