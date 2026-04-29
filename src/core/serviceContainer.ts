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
import type { SessionManager } from "../aws/sessionManager";
import type { CloudViewConfiguration, Logger } from "./contracts";
import type { CloudViewPlatform } from "./platform";
import type { DiscoveryCoordinator } from "./discoveryCoordinator";

/**
 * CloudViewServiceContainer is the central service container that holds references
 * to all major components of the CloudView platform, including registries, repositories,
 * session management, AWS client factory, scheduler, and configuration loader.
 */

export class CloudViewServiceContainer implements CloudViewPlatform {
  public graphEngine!: GraphEngine;
  public discoveryCoordinator!: DiscoveryCoordinator;

  public constructor(
    public readonly extensionContext: vscode.ExtensionContext,
    public readonly logger: Logger,
    public readonly resourceRegistry: ResourceRegistry,
    public readonly resolverRegistry: ResolverRegistry,
    public readonly actionRegistry: ActionRegistry,
    public readonly resourceRepo: ResourceRepo,
    public readonly edgeRepo: EdgeRepo,
    public readonly graphRepo: GraphRepo,
    public readonly discoveryJobRepo: DiscoveryJobRepo,
    public readonly sessionManager: SessionManager,
    public readonly awsClientFactory: AwsClientFactory,
    public readonly scheduler: AwsRequestScheduler,
    private readonly configLoader: () => CloudViewConfiguration
  ) {}

  public getConfig(): CloudViewConfiguration {
    return this.configLoader();
  }
}
