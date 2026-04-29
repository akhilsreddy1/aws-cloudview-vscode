import type * as vscode from "vscode";
import type { AwsClientFactory } from "../aws/awsClientFactory";
import type { AwsRequestScheduler } from "../aws/throttler";
import type { DiscoveryJobRepo } from "../db/discoveryJobRepo";
import type { EdgeRepo } from "../db/edgeRepo";
import type { ResourceRepo } from "../db/resourceRepo";
import type { GraphEngine } from "../graph/graphEngine";
import type { GraphRepo } from "../graph/graphRepo";
import type { ActionRegistry } from "../registry/actionRegistry";
import type { ResourceRegistry } from "../registry/resourceRegistry";
import type { ResolverRegistry } from "../registry/resolverRegistry";
import type { CloudViewConfiguration, Logger } from "./contracts";
import type { DiscoveryCoordinator } from "./discoveryCoordinator";
import type { SessionManager } from "../aws/sessionManager";

/**
 * The central service-locator interface passed to every plugin, discoverer,
 * resolver, action, and UI panel. It provides access to all infrastructure
 * services (registries, repos, AWS clients, scheduler, etc.) as read-only
 * properties, keeping individual modules decoupled from the concrete
 * {@link CloudViewServiceContainer} implementation.
 */
export interface CloudViewPlatform {
  /** VS Code extension context used for storage paths and subscriptions. */
  readonly extensionContext: vscode.ExtensionContext;
  readonly logger: Logger;
  /** Registry of all registered {@link ResourceTypeDefinition} objects. */
  readonly resourceRegistry: ResourceRegistry;
  /** Registry of all registered {@link RelationshipResolver} objects. */
  readonly resolverRegistry: ResolverRegistry;
  /** Registry of all registered {@link ResourceAction} objects. */
  readonly actionRegistry: ActionRegistry;
  /** SQLite-backed repository for cached {@link ResourceNode} objects. */
  readonly resourceRepo: ResourceRepo;
  /** SQLite-backed repository for cached {@link Edge} objects. */
  readonly edgeRepo: EdgeRepo;
  /**
   * Store-agnostic graph traversal primitives (multi-hop walk, path, subgraph).
   * Callers should prefer this over walking {@link edgeRepo} directly so the
   * backing store can be swapped (e.g. KuzuDB) without touching call sites.
   */
  readonly graphRepo: GraphRepo;
  /** SQLite-backed repository for {@link DiscoveryJob} state tracking. */
  readonly discoveryJobRepo: DiscoveryJobRepo;
  /** Manages AWS CLI profile resolution and region selection. */
  readonly sessionManager: SessionManager;
  /** Creates and caches AWS SDK clients per profile/region. */
  readonly awsClientFactory: AwsClientFactory;
  /** Token-bucket throttler for outbound AWS API calls. */
  readonly scheduler: AwsRequestScheduler;
  /** Orchestrates resource discovery and relationship resolution runs. */
  readonly discoveryCoordinator: DiscoveryCoordinator;
  /** Traverses and queries the in-memory/cached resource graph. */
  readonly graphEngine: GraphEngine;
  /** Returns the current live {@link CloudViewConfiguration} from VS Code settings. */
  getConfig(): CloudViewConfiguration;
}
