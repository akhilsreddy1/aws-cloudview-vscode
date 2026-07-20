import * as vscode from "vscode";
import { AwsClientFactory } from "./aws/awsClientFactory";
import { proxyConfigAffectedBy } from "./aws/proxyConfig";
import type { ProfileCredentialIssue } from "./aws/sessionManager";
import { SessionManager } from "./aws/sessionManager";
import { AwsRequestScheduler } from "./aws/throttler";
import { readCloudViewConfiguration } from "./core/config";
import { ResourceTypes } from "./core/resourceTypes";
import type { RefreshScopeOutcome } from "./core/discoveryCoordinator";
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
import { registerKinesisPlugin } from "./plugins/kinesis/kinesisDiscoverer";
import { KinesisPeekPanel } from "./ui/kinesisPeekPanel";
import { KinesisTargetsPanel } from "./ui/kinesisTargetsPanel";
import { registerApiGatewayPlugins } from "./plugins/apigateway/apiGatewayDiscoverer";
import { registerApiGatewayRelationshipResolvers } from "./plugins/apigateway/relationshipResolvers";
import { registerGluePlugin } from "./plugins/glue/glueDiscoverer";
import { registerSecretsManagerPlugin } from "./plugins/secretsmanager/secretsManagerDiscoverer";
import { GraphWebView } from "./ui/graphWebView";
import { ServiceDetailPanel } from "./ui/serviceDetailPanel";
import { showGoToResource } from "./ui/goToResourceCommand";
import { CloudWatchLogsPanel } from "./ui/lambdaLogsPanel";
import { LambdaInvokePanel } from "./ui/lambdaInvokePanel";
import { StepFunctionsExecutionPanel } from "./ui/stepFunctionsExecutionPanel";
import { StepFunctionsGraphPanel } from "./ui/stepFunctionsGraphPanel";
import { EcrImagesPanel } from "./ui/ecrImagesPanel";
import { EcsTaskDefPanel } from "./ui/ecsTaskDefPanel";
import { PublicExposurePanel } from "./ui/publicExposurePanel";
import { LogGroupListPanel, LogStreamsPanel } from "./ui/logStreamsPanel";
import { S3BrowserPanel } from "./ui/s3BrowserPanel";
import { SqsMessagesPanel } from "./ui/sqsMessagesPanel";
import { MskTopicsPanel } from "./ui/mskTopicsPanel";
import { DynamoDbItemsPanel } from "./ui/dynamodbItemsPanel";
import { CfnTemplatePanel } from "./ui/cfnTemplatePanel";
import { CfnStackEventsPanel } from "./ui/cfnStackEventsPanel";
import { CfnStackDependenciesPanel } from "./ui/cfnStackDependenciesPanel";
import { launchEc2SsmSession, launchEcsExec } from "./ui/sessionLauncher";
import { AthenaQueryPanel } from "./ui/athenaQueryPanel";
import { LogsInsightsPanel } from "./ui/logsInsightsPanel";
import { ApiGatewayRoutesPanel } from "./ui/apiGatewayRoutesPanel";
import { LoadBalancerHierarchyPanel } from "./ui/loadBalancerHierarchyPanel";
import { DatabaseHierarchyPanel } from "./ui/databaseHierarchyPanel";
import { EcsHierarchyPanel } from "./ui/ecsHierarchyPanel";
import { GlueJobRunsPanel } from "./ui/glueJobRunsPanel";
import { SecretValuePanel } from "./ui/secretValuePanel";
import { SystemsManagerPanel } from "./ui/systemsManagerPanel";
import { WelcomePanel } from "./ui/welcomePanel";
import { CloudTreeViewProvider, type ServiceTreeNode } from "./ui/treeViewProvider";
import { requireSelectedSessions } from "./ui/profileGuards";

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
  // Resolution order for the cache directory:
  //   1. `cloudView.storage.path` setting (with `~` expanded), if writable
  //   2. VS Code's per-extension globalStorage (default)
  //
  // We probe the override path before committing to it. If it's unwritable
  // (typo, AV-quarantined, missing permission), fall back gracefully so the
  // extension still activates instead of erroring out at startup.
  const storagePath = await resolveStoragePath(context, logger);
  const database = await sqlite.initialize(storagePath);
  logger.info("Database initialized at " + storagePath);

  logger.info("Initializing CloudView components...");
  const resourceRegistry = new ResourceRegistry(logger);
  const resolverRegistry = new ResolverRegistry();
  const actionRegistry = new ActionRegistry();
  const sessionManager = new SessionManager(
    context,
    logger,
    () => readCloudViewConfiguration().regions,
    () => {
      const cfg = readCloudViewConfiguration();
      return {
        configFilePath: cfg.awsConfigFilePath || undefined,
        credentialsFilePath: cfg.awsCredentialsFilePath || undefined,
      };
    }
  );
  const awsClientFactory = new AwsClientFactory(sessionManager, logger);
  // Reset the AWS client factory and refresh the profiles
  awsClientFactory.reset();
  sessionManager.refreshProfiles();

  const scheduler = new AwsRequestScheduler(readCloudViewConfiguration, logger);

  // When an SDK call surfaces an "expired credentials" error, run the same
  // clear-and-reload path the "CloudView: Reload AWS Profiles" command uses —
  // so the next call re-resolves credentials from disk without needing the
  // user to restart VS Code or run the command manually. Throttled so a burst
  // of failing calls during a refresh storm only triggers one reset.
  let lastAuthResetAt = 0;
  scheduler.setAuthErrorHandler(({ service, operation }) => {
    const now = Date.now();
    if (now - lastAuthResetAt < 15_000) return;
    lastAuthResetAt = now;
    logger.info(`Detected expired AWS credentials on ${service}:${operation} — clearing caches; next call will re-resolve.`);
    awsClientFactory.reset();
    sessionManager.refreshProfiles();
    void vscode.window.setStatusBarMessage(
      `CloudView: AWS credentials looked expired — caches refreshed. Retry your action.`,
      6000,
    );
  });

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
      if (
        evt.affectsConfiguration("cloudView.aws.configFilePath") ||
        evt.affectsConfiguration("cloudView.aws.credentialsFilePath")
      ) {
        // Path overrides changed \u2014 drop the in-memory profile cache so the
        // next listProfiles re-reads from the new location, and clear
        // resolved sessions so subsequent fromIni calls pick up the new path.
        logger.info("AWS ini path setting changed \u2014 reloading profiles.");
        sessionManager.refreshProfiles();
        treeProvider.profileTree.refresh();
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
        const sessions = await requireSelectedSessions(platform, "open the service dashboard");
        if (!sessions) return;
        // Support multiple accounts by extracting unique account IDs from the selected sessions
        const accountIds = [...new Set(sessions.map(s => s.accountId))];
        await ServiceDetailPanel.openMultiScope(platform, node.serviceId, accountIds, selectedRegions);
      }
    }),

    // ── Go to resource: global fuzzy-search over the whole local cache ──
    vscode.commands.registerCommand("cloudView.goToResource", async () => {
      await showGoToResource(platform);
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
      await refreshResources(platform, treeProvider, output);
    }),

    // ── Graph view — account-level by default ──
    vscode.commands.registerCommand("cloudView.openGraphView", async () => {
      const sessions = await requireSelectedSessions(platform, "open the graph");
      if (!sessions) return;
      const accountIds = [...new Set(sessions.map(s => s.accountId))];
      await graphView.showServiceMap(accountIds);
    }),

    vscode.commands.registerCommand("cloudView.openGraphView.fromArn", async (arn: string) => {
      await graphView.show(arn);
    }),

    // ── Service-scoped graph ──
    vscode.commands.registerCommand("cloudView.openServiceGraph", async (serviceId?: string) => {
      const sessions = await requireSelectedSessions(platform, "open the service graph");
      if (!sessions) return;
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

    // ── Open the visual ASL graph for a state machine ──
    vscode.commands.registerCommand("cloudView.sfn.viewGraph", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await StepFunctionsGraphPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("State machine not found in local cache. Refresh resources first.");
      }
    }),

    // ── Kinesis: peek records from a shard ──
    vscode.commands.registerCommand("cloudView.kinesis.peek", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await KinesisPeekPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Kinesis stream not found in local cache. Refresh resources first.");
      }
    }),

    // ── Kinesis: view targets (Lambda mappings, Firehose, EFO consumers) ──
    vscode.commands.registerCommand("cloudView.kinesis.viewTargets", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await KinesisTargetsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Kinesis stream not found in local cache. Refresh resources first.");
      }
    }),

    // ── Glue: view ETL job runs, trigger, stop, and open per-run logs ──
    vscode.commands.registerCommand("cloudView.glue.viewJobRuns", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await GlueJobRunsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Glue job not found in local cache. Refresh resources first.");
      }
    }),

    // ── RDS: cluster → instances → connectivity + read-replica hierarchy ──
    vscode.commands.registerCommand("cloudView.rds.viewHierarchy", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await DatabaseHierarchyPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Database not found in local cache. Refresh resources first.");
      }
    }),

    // ── ECS: cluster → services → tasks → containers hierarchy ──
    vscode.commands.registerCommand("cloudView.ecs.viewHierarchy", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await EcsHierarchyPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("ECS resource not found in local cache. Refresh resources first.");
      }
    }),

    // ── Secrets Manager: view + update a secret value ──
    vscode.commands.registerCommand("cloudView.secretsmanager.viewSecret", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await SecretValuePanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Secret not found in local cache. Refresh resources first.");
      }
    }),

    // ── Systems Manager: parameters, documents, and execution history ──
    vscode.commands.registerCommand("cloudView.ssm.open", async () => {
      await SystemsManagerPanel.open(platform);
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

    // ── MSK: browse Kafka topics ──
    vscode.commands.registerCommand("cloudView.msk.viewTopics", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await MskTopicsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("MSK cluster not found in local cache. Refresh resources first.");
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

    // ── CloudFormation: live-tail stack events ──
    vscode.commands.registerCommand("cloudView.cfn.watchStackEvents", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await CfnStackEventsPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("CloudFormation stack not found in local cache. Refresh resources first.");
      }
    }),

    // ── CloudFormation: stack dependencies (exports / imports / nested) ──
    vscode.commands.registerCommand("cloudView.cfn.viewDependencies", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await CfnStackDependenciesPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("CloudFormation stack not found in local cache. Refresh resources first.");
      }
    }),

    // ── EC2: open an SSM Session Manager shell in a VS Code terminal ──
    vscode.commands.registerCommand("cloudView.ec2.startSession", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await launchEc2SsmSession(platform, resource);
      } else {
        void vscode.window.showWarningMessage("EC2 instance not found in local cache. Refresh resources first.");
      }
    }),

    // ── ECS: exec into a running task's container (`aws ecs execute-command`) ──
    vscode.commands.registerCommand("cloudView.ecs.execCommand", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await launchEcsExec(platform, resource);
      } else {
        void vscode.window.showWarningMessage("ECS task not found in local cache. Refresh resources first.");
      }
    }),

    // ── Athena: query runner (read-only SQL workspace) ──
    vscode.commands.registerCommand("cloudView.athena.openQueryRunner", async () => {
      await AthenaQueryPanel.open(platform);
    }),

    // ── CloudWatch Logs Insights: query workspace across log groups ──
    vscode.commands.registerCommand("cloudView.logs.openInsightsQuery", async () => {
      await LogsInsightsPanel.open(platform);
    }),

    // ── API Gateway: per-API routes & integrations drilldown ──
    vscode.commands.registerCommand("cloudView.apigateway.viewRoutes", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await ApiGatewayRoutesPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("API Gateway API not found in local cache. Refresh resources first.");
      }
    }),

    // ── Load balancer: listeners → target groups → targets hierarchy ──
    vscode.commands.registerCommand("cloudView.elbv2.viewHierarchy", async (arn: string) => {
      const resource = await platform.resourceRepo.getByArn(arn);
      if (resource) {
        await LoadBalancerHierarchyPanel.open(platform, resource);
      } else {
        void vscode.window.showWarningMessage("Load balancer not found in local cache. Refresh resources first.");
      }
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
  registerKinesisPlugin(resourceRegistry);
  registerApiGatewayPlugins(resourceRegistry);
  registerGluePlugin(resourceRegistry);
  registerSecretsManagerPlugin(resourceRegistry);

  // Register relationship resolvers
  registerEc2RelationshipResolvers(resolverRegistry);
  registerS3RelationshipResolvers(resolverRegistry);
  registerLambdaRelationshipResolvers(resolverRegistry);
  registerEcsRelationshipResolvers(resolverRegistry);
  registerRdsRelationshipResolvers(resolverRegistry);
  registerRedshiftRelationshipResolvers(resolverRegistry);
  registerEventBridgeRelationshipResolvers(resolverRegistry);
  registerApiGatewayRelationshipResolvers(resolverRegistry);

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
function truncateForOutputLine(message: string, maxChars: number): string {
  const m = message.replace(/\s+/gu, " ").trim();
  if (m.length <= maxChars) return m;
  return `${m.slice(0, Math.max(40, Math.floor(maxChars / 2) - 2))}\u2026${m.slice(-(Math.floor(maxChars / 2) - 2))}`;
}

/** Writes STS + discovery summaries to the main CloudView output channel. */
function appendRefreshIssuesToOutput(
  output: vscode.OutputChannel,
  credentialFailures: ProfileCredentialIssue[],
  scopeFailures: RefreshScopeOutcome[],
): void {
  output.appendLine("");
  output.appendLine(`━━ Cloud View refresh summary (${new Date().toISOString()}) ━━`);

  if (credentialFailures.length > 0) {
    output.appendLine("");
    output.appendLine("Profile / STS (these profiles did not resolve — discovery skipped):");
    for (const failure of credentialFailures) {
      output.appendLine("");
      output.appendLine(`  Profile "${failure.profileName}":`);
      for (const line of failure.message.split(/\r?\n/)) {
        output.appendLine(`    ${line}`);
      }
    }
  }

  if (scopeFailures.length > 0) {
    output.appendLine("");
    output.appendLine("Discovery partial failures (other types in the same scope may still have succeeded):");
    for (const outcome of scopeFailures) {
      const header = `${outcome.scope.profileName} · acct ${outcome.scope.accountId} · ${outcome.scope.region} · ${outcome.service}`;
      output.appendLine("");
      output.appendLine(`  ${header}`);
      for (const failure of outcome.failures) {
        output.appendLine(
          `    – ${failure.resourceType}: ${truncateForOutputLine(failure.message, 480)}`,
        );
      }
    }
  }

  output.appendLine("");
}

let inFlightRefresh: Promise<void> | undefined;

async function refreshResources(
  platform: CloudViewServiceContainer,
  treeProvider: CloudTreeViewProvider,
  output: vscode.OutputChannel
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

  /** STS / ini resolution before discovery (SSO expiry, proxy, stale selection, …). */
  const profileResolution = await platform.sessionManager.summarizeSelectedProfileSessions();
  if (profileResolution.sessions.length === 0) {
    appendRefreshIssuesToOutput(output, profileResolution.credentialFailures, []);
    void vscode.window
      .showWarningMessage(
        "Cloud View could not resolve any selected AWS profile via STS — check SSO login, credentials, proxy, then run \"CloudView: Reload AWS Profiles\".",
        "Show log",
      )
      .then((choice) => {
        if (choice === "Show log") output.show(true);
      });
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
          /** Per-(scope×service) partial discovery failures logged for summary. */
          const scopeFailures: RefreshScopeOutcome[] = [];
          try {
            await platform.discoveryCoordinator.refreshSelectedProfiles({
              force: true,
              cancellation: composite.token,
              resolvedSessions: profileResolution.sessions,
              onScopeOutcome: (o) => {
                if (o.failures.length > 0) scopeFailures.push(o);
              },
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
                    message: `[${evt.completed} / ${evt.total}] ${evt.current.service} · acct ${evt.current.accountId} · ${evt.current.region}`,
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

          const hadCredentialSkips = profileResolution.credentialFailures.length > 0;
          const hadDiscoveryPartial = scopeFailures.length > 0;
          const hadRefreshIssues = hadCredentialSkips || hadDiscoveryPartial;
          const failedTypeCount = scopeFailures.reduce((n, o) => n + o.failures.length, 0);

          if (hadRefreshIssues) {
            appendRefreshIssuesToOutput(output, profileResolution.credentialFailures, scopeFailures);
          }

          const offerIssuesLogButton = (): void => {
            void vscode.window
              .showWarningMessage(`See "${output.name}" for refresh error details.`, "Show log")
              .then((c) => {
                if (c === "Show log") output.show(true);
              });
          };

          if (timedOut) {
            platform.logger.warn(
              `Refresh exceeded the configured timeout of ${timeoutSeconds}s; aborted. Partial results kept in cache.`
            );
            let msg = `Cloud View refresh timed out after ${timeoutSeconds}s. Partial results kept; raise cloudView.refresh.timeoutSeconds (or set to 0 to disable) if your environment needs longer.`;
            if (hadRefreshIssues) {
              const profilePart = profileResolution.credentialFailures.length
                ? ` ${profileResolution.credentialFailures.length} profile(s) did not STS-resolve.`
                : "";
              const discPart = hadDiscoveryPartial ? ` ${failedTypeCount} discovery error(s).` : "";
              msg += `${profilePart}${discPart}`;
            }
            if (hadRefreshIssues) {
              void vscode.window.showWarningMessage(msg, "Show log").then((c) => {
                if (c === "Show log") output.show(true);
              });
            } else {
              void vscode.window.showWarningMessage(msg);
            }
          } else if (token.isCancellationRequested) {
            platform.logger.info("Refresh cancelled by user; partial results kept in cache.");
            void vscode.window.setStatusBarMessage(
              "Cloud View refresh cancelled — partial results kept.",
              4000
            );
            if (hadRefreshIssues) offerIssuesLogButton();
          } else if (hadRefreshIssues) {
            const skippedPhrase =
              profileResolution.credentialFailures.length === 1
                ? `Profile "${profileResolution.credentialFailures[0].profileName}" did not STS-resolve`
                : `${profileResolution.credentialFailures.length} profile(s) did not STS-resolve`;
            const discoPhrase = `${failedTypeCount} discovery error(s) across ${scopeFailures.length} scope(s)`;
            let summaryDetail: string;
            if (hadCredentialSkips && hadDiscoveryPartial) {
              summaryDetail = `${skippedPhrase}; ${discoPhrase}`;
            } else if (hadCredentialSkips) {
              summaryDetail = skippedPhrase;
            } else {
              summaryDetail = discoPhrase;
            }
            void vscode.window.showWarningMessage(`Cloud View refresh finished with issues: ${summaryDetail}.`, "Show log").then((c) => {
              if (c === "Show log") output.show(true);
            });
          } else {
            void vscode.window.setStatusBarMessage("Cloud View: refresh completed.", 2500);
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

/**
 * Decide where the local SQLite cache lives. Checks the `cloudView.storage.path`
 * override first (with `~` expansion + a write probe), falls back to VS Code's
 * default `globalStorageUri` on any failure. The fallback path is the right
 * default for 99% of users; the override exists for corp environments where
 * `globalStorage` is on a read-only / AV-monitored / roaming-conflicted path.
 *
 * Why probe instead of just trusting the setting: an unwritable override
 * would crash extension activation entirely (no logger, no panel, just a
 * red bar). Probing lets us log a clear warning and degrade gracefully.
 */
async function resolveStoragePath(
  context: vscode.ExtensionContext,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<string> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const fallback = context.globalStorageUri.fsPath;
  const override = (readCloudViewConfiguration().storagePath || "").trim();
  if (!override) return fallback;

  // Expand `~` and `~/` to the home dir. `path.resolve` handles relative
  // segments after that.
  const expanded = override.startsWith("~")
    ? path.join(os.homedir(), override.slice(override.startsWith("~/") ? 2 : 1))
    : override;
  const resolved = path.resolve(expanded);

  // Probe: try to create the directory and write a tiny test file. If either
  // fails, log a warning and use the fallback.
  try {
    await fs.mkdir(resolved, { recursive: true });
    const probe = path.join(resolved, ".cloudview-write-probe");
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    logger.info(`Storage override active: using ${resolved} (instead of ${fallback})`);
    return resolved;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `cloudView.storage.path override "${override}" is not writable (${msg}). Falling back to default ${fallback}.`,
    );
    return fallback;
  }
}
