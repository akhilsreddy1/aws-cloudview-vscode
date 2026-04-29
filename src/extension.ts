import * as vscode from "vscode";
import { AwsClientFactory } from "./aws/awsClientFactory";
import { proxyConfigAffectedBy } from "./aws/proxyConfig";
import { SessionManager } from "./aws/sessionManager";
import { AwsRequestScheduler } from "./aws/throttler";
import { readCloudViewConfiguration } from "./core/config";
import { ResourceTypes } from "./core/resourceTypes";
import { DiscoveryCoordinator } from "./core/discoveryCoordinator";
import { OutputChannelLogger } from "./core/logger";
import { CloudViewServiceContainer } from "./core/serviceContainer";
import { SqliteDatabase } from "./db/sqlite";
import { DiscoveryJobRepo } from "./db/discoveryJobRepo";
import { EdgeRepo } from "./db/edgeRepo";
import { ResourceRepo } from "./db/resourceRepo";
import { GraphEngine } from "./graph/graphEngine";
import { SqliteGraphRepo } from "./graph/graphRepoSqlite";
import {
  registerDefaultActions,
  registerEcsActions,
  registerEc2Actions,
  registerRdsActions,
  ActionRegistry,
} from "./registry/actionRegistry";
import { ResourceRegistry } from "./registry/resourceRegistry";
import { ResolverRegistry } from "./registry/resolverRegistry";
import { registerVpcPlugin } from "./plugins/vpc/vpcDiscoverer";
import { registerVpcEndpointPlugin } from "./plugins/vpc/vpcEndpointDiscoverer";
import { registerVpcLatticePlugins } from "./plugins/vpc/vpcLatticeDiscoverer";
import { registerSubnetPlugin } from "./plugins/subnet/subnetDiscoverer";
import { registerSecurityGroupPlugin } from "./plugins/sg/securityGroupDiscoverer";
import { registerEc2InstancePlugin } from "./plugins/ec2/instanceDiscoverer";
import { registerEc2RelationshipResolvers } from "./plugins/ec2/relationshipResolvers";

import { registerS3BucketPlugin } from "./plugins/s3/s3BucketDiscoverer";
import { registerS3RelationshipResolvers } from "./plugins/s3/relationshipResolvers";
import { registerLambdaPlugin } from "./plugins/lambda/lambdaDiscoverer";
import { registerLambdaRelationshipResolvers } from "./plugins/lambda/relationshipResolvers";
import { registerEcsClusterPlugin, registerEcsServicePlugin, registerEcsTaskPlugin } from "./plugins/ecs/ecsDiscoverer";
import { registerEcsRelationshipResolvers } from "./plugins/ecs/relationshipResolvers";
import { registerEcrPlugin } from "./plugins/ecr/ecrDiscoverer";
import { registerRdsInstancePlugin, registerRdsClusterPlugin, registerRdsSnapshotPlugin, registerRdsClusterSnapshotPlugin } from "./plugins/rds/rdsDiscoverer";
import { registerRdsRelationshipResolvers } from "./plugins/rds/relationshipResolvers";
import { registerDynamodbPlugin } from "./plugins/dynamodb/dynamodbDiscoverer";
import { registerRedshiftPlugin } from "./plugins/redshift/redshiftDiscoverer";
import { registerRedshiftRelationshipResolvers } from "./plugins/redshift/relationshipResolvers";
import { registerEventBridgeBusPlugin, registerEventBridgeRulePlugin } from "./plugins/eventbridge/eventbridgeDiscoverer";
import { registerEventBridgeRelationshipResolvers } from "./plugins/eventbridge/relationshipResolvers";
import { registerMskPlugin } from "./plugins/msk/mskDiscoverer";
import { registerAlbPlugin, registerTargetGroupPlugin } from "./plugins/elbv2/elbv2Discoverer";
import { registerCfnStackPlugin } from "./plugins/cloudformation/cfnDiscoverer";
import { registerSfnPlugin } from "./plugins/stepfunctions/sfnDiscoverer";
import { registerLogsPlugin } from "./plugins/logs/logsDiscoverer";
import { registerSqsPlugin } from "./plugins/sqs/sqsDiscoverer";
import { GraphWebView } from "./ui/graphWebView";
import { ServiceDetailPanel } from "./ui/serviceDetailPanel";
import { CloudWatchLogsPanel } from "./ui/lambdaLogsPanel";
import { LambdaInvokePanel } from "./ui/lambdaInvokePanel";
import { StepFunctionsExecutionPanel } from "./ui/stepFunctionsExecutionPanel";
import { EcrImagesPanel } from "./ui/ecrImagesPanel";
import { EcsTaskDefPanel } from "./ui/ecsTaskDefPanel";
import { PublicExposurePanel } from "./ui/publicExposurePanel";
import { LogGroupListPanel, LogStreamsPanel } from "./ui/logStreamsPanel";
import { S3BrowserPanel } from "./ui/s3BrowserPanel";
import { SqsMessagesPanel } from "./ui/sqsMessagesPanel";
import { DynamoDbItemsPanel } from "./ui/dynamodbItemsPanel";
import { CfnTemplatePanel } from "./ui/cfnTemplatePanel";
import { AthenaQueryPanel } from "./ui/athenaQueryPanel";
import { WelcomePanel } from "./ui/welcomePanel";
import { CloudTreeViewProvider, type ServiceTreeNode } from "./ui/treeViewProvider";

let sqlite: SqliteDatabase | undefined;

/**
 * This function is called when the VS Code extension is deactivated.
 * It performs any necessary cleanup, such as closing the local SQLite database.
 */
export async function deactivate(): Promise<void> {
  if (sqlite) {
    await sqlite.close();
    sqlite = undefined;
  }
}

/**
 * This function is called when the VS Code extension is activated.
 * It sets up all necessary components, including the database, registries,
 * service container, tree view, and command registrations.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Cloud View for AWS");
  const logger = new OutputChannelLogger(output);

  sqlite = new SqliteDatabase();
  const database = await sqlite.initialize(context.globalStorageUri.fsPath);
  logger.info("Database initialized at " + context.globalStorageUri.fsPath);

  logger.info("Initializing CloudView components...");
  const resourceRegistry = new ResourceRegistry(logger);
  const resolverRegistry = new ResolverRegistry();
  const actionRegistry = new ActionRegistry();
  const sessionManager = new SessionManager(context, logger, () => readCloudViewConfiguration().regions);
  const awsClientFactory = new AwsClientFactory(sessionManager, logger);
  // Reset the AWS client factory and refresh the profiles
  awsClientFactory.reset();
  sessionManager.refreshProfiles();

  const scheduler = new AwsRequestScheduler(readCloudViewConfiguration, logger);
  const resourceRepo = new ResourceRepo(database);
  const edgeRepo = new EdgeRepo(database);
  const graphRepo = new SqliteGraphRepo(database);
  const discoveryJobRepo = new DiscoveryJobRepo(database);

  /* Initialize the central CloudView service container with all major components */
  const platform = new CloudViewServiceContainer(
    context,
    logger,
    resourceRegistry,
    resolverRegistry,
    actionRegistry,
    resourceRepo,
    edgeRepo,
    graphRepo,
    discoveryJobRepo,
    sessionManager,
    awsClientFactory,
    scheduler,
    readCloudViewConfiguration
  );

  const discoveryCoordinator = new DiscoveryCoordinator(platform);
  platform.discoveryCoordinator = discoveryCoordinator;
  const graphEngine = new GraphEngine(platform);
  platform.graphEngine = graphEngine;

  logger.info("CloudView Registering platform plugins...");
  registerPlatformPlugins(resourceRegistry, resolverRegistry, actionRegistry);

  /* Initialize the tree view provider and graph view */
  const treeProvider = new CloudTreeViewProvider(platform);
  const graphView = new GraphWebView(platform);

  /* Register tree view and graph view commands to handle user interactions */
  context.subscriptions.push(
    output,

    vscode.workspace.onDidChangeConfiguration((evt) => {
      if (proxyConfigAffectedBy(evt)) {
        logger.info("Proxy configuration changed \u2014 recreating AWS clients.");
        awsClientFactory.reset();
        sessionManager.clearResolvedSessions();
      }
    }),

    // On Extenstion activation, the tree view providers are registered and the commands are registered.
    vscode.window.registerTreeDataProvider("cloudViewServices", treeProvider.serviceTree),
    vscode.window.registerTreeDataProvider("cloudViewRegions", treeProvider.regionTree),
    vscode.window.registerTreeDataProvider("cloudViewProfiles", treeProvider.profileTree),
    vscode.commands.registerCommand("cloudView.openWelcome", () => {
      WelcomePanel.open(context);
    }),


    // All the commands are registered here ; binding the id to an handler function.
    vscode.commands.registerCommand("cloudView.openServiceDetail", async (node?: ServiceTreeNode) => {
      const selectedProfiles = await sessionManager.getSelectedProfiles();
      const selectedRegions = await sessionManager.getSelectedRegions();

      if (selectedProfiles.length === 0) {
        void vscode.window.showInformationMessage("Select at least one AWS profile in the sidebar first.");
        return;
      }
      if (selectedRegions.length === 0) {
        void vscode.window.showInformationMessage("Select at least one region in the sidebar first.");
        return;
      }

      if (node?.kind === "service") {
        const sessions = await sessionManager.getSelectedProfileSessions();
        if (sessions.length === 0) {
          return;
        }
        // Support multiple accounts by extracting unique account IDs from the selected sessions
        const accountIds = [...new Set(sessions.map(s => s.accountId))];
        await ServiceDetailPanel.openMultiScope(platform, node.serviceId, accountIds, selectedRegions);
      }
    }),

    // ── Profile and region toggles ──
    vscode.commands.registerCommand("cloudView.toggleProfile", async (profileName: string) => {
      await sessionManager.toggleProfile(profileName);
      treeProvider.profileTree.refresh();
    }),

    vscode.commands.registerCommand("cloudView.toggleRegion", async (region: string) => {
      await sessionManager.toggleRegion(region);
      treeProvider.regionTree.refresh();
    }),

    vscode.commands.registerCommand("cloudView.selectProfile", async () => {
      await selectProfiles(sessionManager);
      treeProvider.profileTree.refresh();
    }),

    // ── Reload ~/.aws/{config,credentials} and drop cached sessions/clients ──
    vscode.commands.registerCommand("cloudView.refreshProfiles", async () => {
      awsClientFactory.reset();
      sessionManager.refreshProfiles();
      const profiles = await sessionManager.listProfiles();
      treeProvider.profileTree.refresh();
      void vscode.window.setStatusBarMessage(
        `CloudView: reloaded ${profiles.length} AWS profile${profiles.length === 1 ? "" : "s"}`,
        2500
      );
    }),

    // ── Refresh all ──
    vscode.commands.registerCommand("cloudView.refreshResources", async () => {
      await refreshResources(platform, treeProvider);
    }),

    // ── Graph view — account-level by default ──
    vscode.commands.registerCommand("cloudView.openGraphView", async () => {
      const sessions = await sessionManager.getSelectedProfileSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage("Select at least one AWS profile to open the graph.");
        return;
      }
      const accountIds = [...new Set(sessions.map(s => s.accountId))];
      await graphView.showServiceMap(accountIds);
    }),

    vscode.commands.registerCommand("cloudView.openGraphView.fromArn", async (arn: string) => {
      await graphView.show(arn);
    }),

    // ── Service-scoped graph ──
    vscode.commands.registerCommand("cloudView.openServiceGraph", async (serviceId?: string) => {
      const sessions = await sessionManager.getSelectedProfileSessions();
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage("Select at least one AWS profile first.");
        return;
      }
      const accountIds = [...new Set(sessions.map(s => s.accountId))];
      const services = serviceId ? [serviceId] : undefined;
      await graphView.showServiceMap(accountIds, services);
    }),

    // ── CloudWatch Logs: Lambda → embedded group tail; ECS → in-app list then LogStreamsPanel ──
    vscode.commands.registerCommand("cloudView.viewLogs", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (!resource) {
        void vscode.window.showWarningMessage("Resource not found in local cache. Refresh resources first.");
        return;
      }
      const isEcs =
        resource.type === ResourceTypes.ecsCluster ||
        resource.type === ResourceTypes.ecsService ||
        resource.type === ResourceTypes.ecsTask;
      // If the resource is an ECS cluster, service, or task, open the log group list panel.
      // Otherwise, open the CloudWatch logs panel.
      if (isEcs) {
        await LogGroupListPanel.open(platform, resource);
        return;
      }
      // If the resource is a Lambda function or any other resource, open the CloudWatch logs panel.
      await CloudWatchLogsPanel.showForResource(platform, resource);
    }),

    // ── Invoke Lambda ──
    vscode.commands.registerCommand("cloudView.invokeLambda", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await LambdaInvokePanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Resource not found in local cache. Refresh resources first.");
      }
    }),

    // ── Start Step Functions execution ──
    vscode.commands.registerCommand("cloudView.executeStateMachine", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await StepFunctionsExecutionPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("State machine not found in local cache. Refresh resources first.");
      }
    }),

    // ── CloudWatch Logs: browse log streams in a specific group ──
    vscode.commands.registerCommand("cloudView.logs.browseStreams", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await LogStreamsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Log group not found in local cache. Refresh resources first.");
      }
    }),

    // ── ECR: view image tags ──
    vscode.commands.registerCommand("cloudView.ecr.viewImages", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await EcrImagesPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("ECR repository not found in local cache.");
      }
    }),

    // ── ECS: view task definition ──
    vscode.commands.registerCommand("cloudView.ecs.viewTaskDef", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await EcsTaskDefPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("ECS resource not found in local cache.");
      }
    }),

    // ── S3: browse prefixes + upload ──
    vscode.commands.registerCommand("cloudView.s3.browsePrefixes", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await S3BrowserPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("S3 bucket not found in local cache.");
      }
    }),

    // ── SQS: peek messages + redrive DLQs ──
    vscode.commands.registerCommand("cloudView.sqs.viewMessages", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await SqsMessagesPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("SQS queue not found in local cache. Refresh resources first.");
      }
    }),

    // ── DynamoDB: scan / query latest items ──
    vscode.commands.registerCommand("cloudView.dynamodb.peekItems", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await DynamoDbItemsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("DynamoDB table not found in local cache. Refresh resources first.");
      }
    }),

    // ── CloudFormation: view template (Original / Processed) ──
    vscode.commands.registerCommand("cloudView.cfn.viewTemplate", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await CfnTemplatePanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("CloudFormation stack not found in local cache. Refresh resources first.");
      }
    }),

    // ── Athena: query runner (read-only SQL workspace) ──
    vscode.commands.registerCommand("cloudView.athena.openQueryRunner", async () => {
      await AthenaQueryPanel.open(platform);
    }),

    // ── Check public exposure ──
    vscode.commands.registerCommand("cloudView.checkPublicExposure", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await PublicExposurePanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Resource not found in local cache.");
      }
    }),

    // ── Clear local database ──
    vscode.commands.registerCommand("cloudView.clearDatabase", async () => {
      const answer = await vscode.window.showWarningMessage(
        "This will delete all cached resources, edges, and discovery jobs from the local SQLite database. Continue?",
        { modal: true },
        "Clear Database"
      );
      if (answer === "Clear Database") {
        await sqlite?.clearAll();
        treeProvider.refresh();
        void vscode.window.showInformationMessage("Cloud View local database cleared.");
        logger.info("Local SQLite database cleared by user.");
      }
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cloudView")) {
        treeProvider.refresh();
      }
    })
  );

  WelcomePanel.open(context);

  logger.info("Cloud View for AWS activated");
}


/**
 * Registers all built-in AWS service plugins with the platform registries.
 *
 * This function wires together three categories of registration:
 * - **Resource plugins**: register resource types (VPC, EC2, Lambda, RDS, etc.)
 *   so the platform knows how to discover and display them.
 * - **Relationship resolvers**: register cross-service edge resolvers that
 *   derive relationships between discovered resources (e.g. Lambda → VPC, ECS → RDS).
 * - **Default actions**: register the built-in context-menu actions available
 *   on resources in the tree view and graph.
 *
 * Call this once during extension activation, after the registries are created
 * and before the tree view or graph view are rendered.
 */
function registerPlatformPlugins(
  resourceRegistry: ResourceRegistry,
  resolverRegistry: ResolverRegistry,
  actionRegistry: ActionRegistry
): void {
  // Register resource plugins
  registerVpcPlugin(resourceRegistry);
  registerSubnetPlugin(resourceRegistry);
  registerSecurityGroupPlugin(resourceRegistry);
  registerVpcEndpointPlugin(resourceRegistry);
  registerVpcLatticePlugins(resourceRegistry);
  registerEc2InstancePlugin(resourceRegistry);
  registerAlbPlugin(resourceRegistry);
  registerTargetGroupPlugin(resourceRegistry);
  registerS3BucketPlugin(resourceRegistry);
  registerLambdaPlugin(resourceRegistry);
  registerEcsClusterPlugin(resourceRegistry);
  registerEcsServicePlugin(resourceRegistry);
  registerEcsTaskPlugin(resourceRegistry);
  registerEcrPlugin(resourceRegistry);
  registerRdsInstancePlugin(resourceRegistry);
  registerRdsClusterPlugin(resourceRegistry);
  registerRdsSnapshotPlugin(resourceRegistry);
  registerRdsClusterSnapshotPlugin(resourceRegistry);
  registerDynamodbPlugin(resourceRegistry);
  registerRedshiftPlugin(resourceRegistry);
  registerEventBridgeBusPlugin(resourceRegistry);
  registerEventBridgeRulePlugin(resourceRegistry);
  registerMskPlugin(resourceRegistry);
  registerCfnStackPlugin(resourceRegistry);
  registerSfnPlugin(resourceRegistry);
  registerLogsPlugin(resourceRegistry);
  registerSqsPlugin(resourceRegistry);

  // Register relationship resolvers
  registerEc2RelationshipResolvers(resolverRegistry);
  registerS3RelationshipResolvers(resolverRegistry);
  registerLambdaRelationshipResolvers(resolverRegistry);
  registerEcsRelationshipResolvers(resolverRegistry);
  registerRdsRelationshipResolvers(resolverRegistry);
  registerRedshiftRelationshipResolvers(resolverRegistry);
  registerEventBridgeRelationshipResolvers(resolverRegistry);

  // Register default actions
  registerDefaultActions(actionRegistry);
  registerEcsActions(actionRegistry);
  registerEc2Actions(actionRegistry);
  registerRdsActions(actionRegistry);
}

async function selectProfiles(sessionManager: SessionManager): Promise<void> {
  const profiles = await sessionManager.listProfiles();
  if (profiles.length === 0) {
    void vscode.window.showWarningMessage(
      "Cloud View for AWS could not find any AWS CLI profiles in ~/.aws/config or ~/.aws/credentials."
    );
    return;
  }

  const selected = await sessionManager.getSelectedProfiles();
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: profile.region,
      picked: selected.includes(profile.name)
    })),
    { canPickMany: true, title: "Select AWS profiles for Cloud View" }
  );

  if (!picked) {
    return;
  }

  await sessionManager.setSelectedProfiles(picked.map((item) => item.label));
}


/**
 * Refreshes the resources for the selected AWS profiles and updates the tree view.
 * If no profiles are selected, an informational message is shown.
 */

/**
 * Single-flight guard for the global refresh. If a refresh is already in
 * progress and the user triggers another (keybind mash, double-click on the
 * toolbar button, etc.), we attach to the existing promise instead of
 * spawning a second `withProgress` notification and a second discovery run.
 * Cleared in a `finally` so a failed refresh doesn't wedge future ones.
 */
let inFlightRefresh: Promise<void> | undefined;

async function refreshResources(
  platform: CloudViewServiceContainer,
  treeProvider: CloudTreeViewProvider
): Promise<void> {
  if (inFlightRefresh) {
    void vscode.window.setStatusBarMessage("Cloud View refresh already in progress\u2026", 2500);
    return inFlightRefresh;
  }

  const selectedProfiles = await platform.sessionManager.getSelectedProfiles();
  if (selectedProfiles.length === 0) {
    void vscode.window.showInformationMessage("Select an AWS profile before refreshing Cloud View resources.");
    return;
  }

  // Read the wall-clock timeout once per refresh so toggling it in settings
  // takes effect on the next click without an extension restart.
  const timeoutSeconds = readCloudViewConfiguration().refreshTimeoutSeconds;

  inFlightRefresh = (async () => {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Refreshing Cloud View resources",
          cancellable: true
        },
        async (progress, token) => {
          // We want both the user's Cancel button AND a configurable
          // wall-clock timeout to abort the refresh through the same path.
          // VS Code's `token` is read-only, so we layer our own
          // `CancellationTokenSource`, link it to the user's token, and arm
          // a setTimeout that calls `.cancel()` if the budget elapses.
          const composite = new vscode.CancellationTokenSource();
          const userCancelSub = token.onCancellationRequested(() => composite.cancel());
          let timedOut = false;
          const timer =
            timeoutSeconds > 0
              ? setTimeout(() => {
                  timedOut = true;
                  composite.cancel();
                }, timeoutSeconds * 1000)
              : undefined;

          // The coordinator emits one event per (profile, region, service)
          // tuple. We translate that into VS Code progress increments —
          // `increment` is a percentage of the bar (0..100), so each unit
          // contributes 100/total. The `message` shows what's currently being
          // processed plus a [N / total] counter so users get a sense of pace.
          let lastReportedAt = 0;
          try {
            await platform.discoveryCoordinator.refreshSelectedProfiles({
              force: true,
              cancellation: composite.token,
              onProgress: (evt) => {
                const incrementPerUnit = evt.total > 0 ? 100 / evt.total : 0;
                // Throttle message updates to ~10/sec so the notification text
                // stays readable on large refreshes; always report the
                // increment so the bar advances accurately even when message
                // updates are skipped.
                const now = Date.now();
                const shouldUpdateMessage = now - lastReportedAt > 100 || evt.completed === evt.total;
                if (shouldUpdateMessage) {
                  lastReportedAt = now;
                  progress.report({
                    message: `[${evt.completed} / ${evt.total}] ${evt.current.service} · ${evt.current.region}`,
                    increment: incrementPerUnit,
                  });
                } else {
                  progress.report({ increment: incrementPerUnit });
                }
              },
            });
          } finally {
            if (timer) clearTimeout(timer);
            userCancelSub.dispose();
            composite.dispose();
          }

          if (timedOut) {
            platform.logger.warn(
              `Refresh exceeded the configured timeout of ${timeoutSeconds}s; aborted. Partial results kept in cache.`
            );
            void vscode.window.showWarningMessage(
              `Cloud View refresh timed out after ${timeoutSeconds}s. Partial results kept; raise cloudView.refresh.timeoutSeconds (or set to 0 to disable) if your environment needs longer.`
            );
          } else if (token.isCancellationRequested) {
            platform.logger.info("Refresh cancelled by user; partial results kept in cache.");
            void vscode.window.setStatusBarMessage(
              "Cloud View refresh cancelled — partial results kept.",
              4000
            );
          }
        }
      );
      treeProvider.refresh();
    } finally {
      inFlightRefresh = undefined;
    }
  })();

  return inFlightRefresh;
}
