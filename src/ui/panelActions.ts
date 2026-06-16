import * as vscode from "vscode";
import {
  DescribeTopicCommand,
  DescribeTopicPartitionsCommand,
  ListTopicsCommand,
} from "@aws-sdk/client-kafka";
import { DeleteStackCommand } from "@aws-sdk/client-cloudformation";
import {
  StartCrawlerCommand,
  StopCrawlerCommand,
  StartWorkflowRunCommand,
  StartTriggerCommand,
  StopTriggerCommand,
} from "@aws-sdk/client-glue";
import type { ResourceNode } from "../core/contracts";
import type { CloudViewPlatform } from "../core/platform";
import {
  isEcsScaleActionId,
  scheduleEcsDiscoveryRefreshAfterMutation,
  isEc2StartStopActionId,
  scheduleEc2DiscoveryRefreshAfterMutation,
  isRdsStartStopActionId,
  scheduleRdsPanelRefreshAfterMutation,
} from "../registry/actionRegistry";

/**
 * Context passed to panel action handlers so they can resolve scope,
 * refresh resources, and post messages back to the webview.
 */
export interface PanelActionContext {
  platform: CloudViewPlatform;
  serviceId: string;
  accountIds: string[];
  queryRegions: string[];
  isMultiScope: boolean;
  postMessage(msg: unknown): Thenable<boolean>;
  refreshPanel(): Promise<void>;
}

/**
 * A panel action handler receives the message payload and the panel context.
 * Return value is ignored; errors should be caught internally.
 */
export type PanelActionHandler = (
  msg: Record<string, unknown>,
  ctx: PanelActionContext
) => Promise<void>;

function isMskClusterServerless(resource: ResourceNode | undefined): boolean {
  if (!resource?.rawJson || typeof resource.rawJson !== "object") return false;
  const raw = resource.rawJson as Record<string, unknown>;
  if (raw.IsServerless === true) return true;
  return String(raw.ClusterType ?? "").toUpperCase() === "SERVERLESS";
}

/**
 * User-facing Kafka control-plane errors (ListTopics / DescribeTopic /
 * DescribeTopicPartitions) including MSK Serverless and IAM pitfalls.
 */
function classifyKafkaControlPlaneError(resource: ResourceNode | undefined, err: unknown): string {
  const serverlessHint = isMskClusterServerless(resource);
  const sdkName =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? String((err as { name: string }).name)
      : "";
  const rawMsg = err instanceof Error ? err.message : String(err);
  const blob = `${sdkName} ${rawMsg}`.toLowerCase();

  if (
    serverlessHint &&
    (sdkName === "BadRequestException" ||
      blob.includes("not supported") ||
      blob.includes("unsupported") ||
      blob.includes("invalid request") ||
      blob.includes("serverless"))
  ) {
    return `MSK Serverless may not expose the same Kafka control-plane topic APIs as provisioned MSK (${sdkName}). If this persists, inspect topics via the AWS Console or Kafka tools connected to bootstrap brokers rather than CloudView APIs. Original: ${rawMsg}`;
  }
  if (sdkName === "UnauthorizedException") {
    return `Unauthorized calling Kafka APIs (${sdkName}). Re-authenticate (\`aws sso login …\`), confirm your IAM principal can invoke MSK Kafka APIs from this workstation, proxy settings (\`HTTPS_PROXY\` / cloudView.proxy.url), then run "CloudView: Reload AWS Profiles". Original: ${rawMsg}`;
  }
  if (sdkName === "ForbiddenException" || blob.includes("forbiddenexception")) {
    return `Access denied (${sdkName}). Grant kafka:ListTopics, kafka:DescribeTopic, kafka:DescribeTopicPartitions (and kafka:DescribeCluster*, if gated) on this cluster ARN. SCPs / VPC endpoints blocking kafka.\`amazonaws.com\` traffic can produce the same symptom. Original: ${rawMsg}`;
  }
  if (sdkName === "NotFoundException" || blob.includes("notfound")) {
    return `Resource not found (${sdkName}). The cluster ARN may be stale or the topic deleted—refresh the MSK dashboard and retry. Original: ${rawMsg}`;
  }
  if (sdkName === "BadRequestException") {
    return `Bad request (${sdkName}) — Kafka rejected the payload. Typical causes: malformed cluster ARN/topic name, mismatched topic state, or feature unavailable for this cluster type. Original: ${rawMsg}`;
  }
  return `Kafka API error (${sdkName || "Error"}): ${rawMsg}`;
}

function decodeKafkaTopicConfigsBase64(encoded: string | undefined): {
  decoded: string;
  note?: string;
} {
  if (!encoded?.trim()) {
    return { decoded: "(none)" };
  }
  try {
    const buf = Buffer.from(encoded, "base64");
    const decoded = buf.toString("utf8").trimEnd();
    if (decoded.length > 16_384) {
      return { decoded: `${decoded.slice(0, 16_384)}\n… truncated …`, note: `${decoded.length} UTF-8 characters total` };
    }
    return { decoded: decoded || "(empty after decode)", note: decoded.length === 0 ? "Decoded UTF-8 is empty." : undefined };
  } catch {
    return { decoded: encoded.slice(0, 480) + (encoded.length > 480 ? "…" : ""), note: "Could not decode as UTF-8; showing raw base64 prefix." };
  }
}

// ─── MSK: List Topics ────────────────────────────────────────────────────────

const listMskTopics: PanelActionHandler = async (msg, ctx) => {
  const clusterArn = msg.clusterArn as string | undefined;
  if (!clusterArn) return;

  const resource = await ctx.platform.resourceRepo.getByArn(clusterArn);
  const accountId = resource?.accountId ?? ctx.accountIds[0];
  const region = resource?.region ?? ctx.queryRegions[0];
  const profileName = await ctx.platform.sessionManager.findProfileNameByAccountId(accountId);
  if (!profileName) {
    await ctx.postMessage({ type: "mskTopicsResult", clusterArn, topics: [], error: "No AWS profile found for this account." });
    return;
  }

  const scope = { profileName, accountId, region };
  try {
    const client = await ctx.platform.awsClientFactory.kafka(scope);
    const topics: Array<{ topicName: string; partitionCount?: number; replicationFactor?: number; topicArn?: string }> = [];
    let nextToken: string | undefined;
    do {
      const response = await ctx.platform.scheduler.run("msk", "ListTopics", () =>
        client.send(new ListTopicsCommand({ ClusterArn: clusterArn, NextToken: nextToken, MaxResults: 100 }))
      );
      for (const t of response.Topics ?? []) {
        topics.push({ topicName: t.TopicName ?? "", partitionCount: t.PartitionCount, replicationFactor: t.ReplicationFactor, topicArn: t.TopicArn });
      }
      nextToken = response.NextToken;
    } while (nextToken);

    topics.sort((a, b) => a.topicName.localeCompare(b.topicName));
    await ctx.postMessage({ type: "mskTopicsResult", clusterArn, topics });
  } catch (err: unknown) {
    const message = classifyKafkaControlPlaneError(resource, err);
    await ctx.postMessage({ type: "mskTopicsResult", clusterArn, topics: [], error: message });
  }
};

const describeMskTopic: PanelActionHandler = async (msg, ctx) => {
  const clusterArn = msg.clusterArn as string | undefined;
  const topicName = msg.topicName as string | undefined;
  if (!clusterArn || !topicName) return;

  const resource = await ctx.platform.resourceRepo.getByArn(clusterArn);
  const accountId = resource?.accountId ?? ctx.accountIds[0];
  const region = resource?.region ?? ctx.queryRegions[0];
  const profileName = await ctx.platform.sessionManager.findProfileNameByAccountId(accountId);
  if (!profileName) {
    await ctx.postMessage({
      type: "mskTopicDescribeResult",
      clusterArn,
      topicName,
      error: "No AWS profile found for this account.",
    });
    return;
  }

  const scope = { profileName, accountId, region };

  interface PartitionRow {
    partition?: number;
    leader?: number;
    replicas?: number[];
    isr?: number[];
  }

  try {
    const client = await ctx.platform.awsClientFactory.kafka(scope);

    const described = await ctx.platform.scheduler.run("msk", "DescribeTopic", () =>
      client.send(new DescribeTopicCommand({ ClusterArn: clusterArn, TopicName: topicName }))
    );

    const partitionsAgg: PartitionRow[] = [];
    let nextToken: string | undefined;
    do {
      const page = await ctx.platform.scheduler.run("msk", "DescribeTopicPartitions", () =>
        client.send(
          new DescribeTopicPartitionsCommand({
            ClusterArn: clusterArn,
            TopicName: topicName,
            MaxResults: 100,
            NextToken: nextToken,
          })
        )
      );
      for (const p of page.Partitions ?? []) {
        partitionsAgg.push({
          partition: p.Partition,
          leader: p.Leader,
          replicas: p.Replicas ?? undefined,
          isr: p.Isr ?? undefined,
        });
      }
      nextToken = page.NextToken;
    } while (nextToken);

    const { decoded: configsUtf8, note: configsNote } = decodeKafkaTopicConfigsBase64(described.Configs);

    await ctx.postMessage({
      type: "mskTopicDescribeResult",
      clusterArn,
      topicName,
      describe: {
        topicArn: described.TopicArn,
        replicationFactor: described.ReplicationFactor,
        partitionCount: described.PartitionCount,
        status: described.Status ? String(described.Status) : undefined,
        configsUtf8,
        configsNote,
      },
      partitions: partitionsAgg.sort((left, right) => (left.partition ?? 0) - (right.partition ?? 0)),
    });
  } catch (err: unknown) {
    await ctx.postMessage({
      type: "mskTopicDescribeResult",
      clusterArn,
      topicName,
      error: classifyKafkaControlPlaneError(resource, err),
    });
  }
};

// ─── CloudFormation: Delete Stack ────────────────────────────────────────────

const deleteCfnStack: PanelActionHandler = async (msg, ctx) => {
  const stackArn = msg.arn as string | undefined;
  if (!stackArn) return;
  const retainResources = msg.retainResources as string[] | undefined;

  const resource = await ctx.platform.resourceRepo.getByArn(stackArn);
  if (!resource) {
    void vscode.window.showWarningMessage("Stack not found in local cache. Refresh and try again.");
    return;
  }
  const confirmation = await vscode.window.showWarningMessage(
    `Delete CloudFormation stack "${resource.name}"?`,
    {
      modal: true,
      detail: `Region: ${resource.region}\nAccount: ${resource.accountId}\n\nThis permanently deletes all resources managed by the stack. Termination protection must be disabled.`,
    },
    "Delete Stack"
  );
  if (confirmation !== "Delete Stack") return;

  const profileName = await ctx.platform.sessionManager.findProfileNameByAccountId(resource.accountId);
  if (!profileName) {
    void vscode.window.showErrorMessage("No AWS profile resolved for this account; cannot delete stack.");
    return;
  }
  const scope = { profileName, accountId: resource.accountId, region: resource.region };
  try {
    const client = await ctx.platform.awsClientFactory.cloudformation(scope);
    await ctx.platform.scheduler.run("cloudformation", "DeleteStack", () =>
      client.send(new DeleteStackCommand({
        StackName: resource.name,
        RetainResources: retainResources && retainResources.length > 0 ? retainResources : undefined,
      }))
    );
    // Notify the user that the delete operation has been initiated and that the panel will refresh shortly
    void vscode.window.showInformationMessage(`Delete initiated for stack "${resource.name}". Refreshing soon…`);
    setTimeout(() => {
      void ctx.platform.discoveryCoordinator
        .refreshServiceScope(scope, ctx.serviceId, { force: true })
        .then(async () => { await ctx.refreshPanel(); })
        .catch(() => { /* soft refresh; panel remains consistent on failure */ });
    }, 1500);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to delete stack: ${message}`);
  }
};

// ─── Command-forwarding handlers ─────────────────────────────────────────────

const executeStateMachine: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.executeStateMachine", msg.arn as string);
};

const invokeLambda: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.invokeLambda", msg.arn as string);
};

const openResource: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.openGraphView.fromArn", msg.arn as string);
};

const viewLogs: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.viewLogs", msg.arn as string);
};

const logsBrowseStreams: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.logs.browseStreams", msg.arn as string);
};

const viewEcrImages: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.ecr.viewImages", msg.arn as string);
};

const mskViewTopics: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.msk.viewTopics", msg.arn as string);
};

const s3BrowsePrefixes: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.s3.browsePrefixes", msg.arn as string);
};

const sqsViewMessages: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.sqs.viewMessages", msg.arn as string);
};

const dynamodbPeekItems: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.dynamodb.peekItems", msg.arn as string);
};

const cfnViewTemplate: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.cfn.viewTemplate", msg.arn as string);
};

const cfnWatchEvents: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.cfn.watchStackEvents", msg.arn as string);
};

const cfnViewDependencies: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.cfn.viewDependencies", msg.arn as string);
};

const ec2StartSession: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.ec2.startSession", msg.arn as string);
};

const ecsExecCommand: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.ecs.execCommand", msg.arn as string);
};

const apigatewayViewRoutes: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.apigateway.viewRoutes", msg.arn as string);
};

const lbViewHierarchy: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.elbv2.viewHierarchy", msg.arn as string);
};

const glueViewRuns: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.glue.viewJobRuns", msg.arn as string);
};

const secretViewValue: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.secretsmanager.viewSecret", msg.arn as string);
};

const rdsViewHierarchy: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.rds.viewHierarchy", msg.arn as string);
};

const ecsViewHierarchy: PanelActionHandler = async (msg) => {
  if (msg.arn) await vscode.commands.executeCommand("cloudView.ecs.viewHierarchy", msg.arn as string);
};

/**
 * Resolve the profile/account/region scope for a Glue inline action from the
 * resource's ARN. Returns `undefined` (and surfaces a toast) if the local
 * cache no longer has the resource or no profile resolves for its account.
 */
async function resolveGlueScope(
  arn: string | undefined,
  ctx: PanelActionContext,
): Promise<{ resource: ResourceNode; client: Awaited<ReturnType<typeof ctx.platform.awsClientFactory.glue>>; name: string } | undefined> {
  if (!arn) return undefined;
  const resource = await ctx.platform.resourceRepo.getByArn(arn);
  if (!resource) {
    void vscode.window.showWarningMessage("Glue resource not found in local cache. Refresh resources first.");
    return undefined;
  }
  const profileName = await ctx.platform.sessionManager.findProfileNameByAccountId(resource.accountId);
  if (!profileName) {
    void vscode.window.showWarningMessage(`No AWS profile resolved for account ${resource.accountId}.`);
    return undefined;
  }
  const scope = { profileName, accountId: resource.accountId, region: resource.region };
  const client = await ctx.platform.awsClientFactory.glue(scope);
  return { resource, client, name: resource.id };
}

/**
 * Toggle a Glue crawler. `msg.glueAction` is "start" or "stop", computed in
 * the dashboard from the row's State. Both actions are behind a modal
 * confirmation because starting a crawler can scan large data targets.
 */
const glueCrawlerToggle: PanelActionHandler = async (msg, ctx) => {
  const action = String(msg.glueAction ?? "");
  if (action !== "start" && action !== "stop") return;
  const ctxOk = await resolveGlueScope(msg.arn as string | undefined, ctx);
  if (!ctxOk) return;
  const { client, name } = ctxOk;
  const verb = action === "start" ? "Start" : "Stop";
  const detail = action === "start"
    ? "The crawler will scan its configured targets and update the Data Catalog. This may incur S3 / catalog charges depending on the target size."
    : "The crawler will stop after its current iteration completes. Partial progress is retained.";
  const confirm = await vscode.window.showWarningMessage(
    `${verb} Glue crawler "${name}"?`,
    { modal: true, detail },
    `${verb} crawler`,
  );
  if (confirm !== `${verb} crawler`) return;
  try {
    if (action === "start") {
      await ctx.platform.scheduler.run("glue", "StartCrawler", () => client.send(new StartCrawlerCommand({ Name: name })));
    } else {
      await ctx.platform.scheduler.run("glue", "StopCrawler", () => client.send(new StopCrawlerCommand({ Name: name })));
    }
    void vscode.window.showInformationMessage(`${verb} requested for crawler "${name}".`);
    // Discovery refresh so the State column reflects the change.
    setTimeout(() => { void ctx.refreshPanel().catch(() => { /* best-effort */ }); }, 1500);
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`${verb}Crawler failed for "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Start a new run of a Glue workflow. Workflows orchestrate jobs/crawlers
 * via triggers; starting one fires the first trigger and runs through the
 * workflow graph.
 */
const glueWorkflowRun: PanelActionHandler = async (msg, ctx) => {
  const ctxOk = await resolveGlueScope(msg.arn as string | undefined, ctx);
  if (!ctxOk) return;
  const { client, name } = ctxOk;
  const confirm = await vscode.window.showWarningMessage(
    `Start a new run of Glue workflow "${name}"?`,
    {
      modal: true,
      detail: "This calls StartWorkflowRun, which fires the workflow's start trigger and runs its jobs/crawlers per the graph. Any side-effects (writes, notifications, billable steps) will happen.",
    },
    "Start workflow",
  );
  if (confirm !== "Start workflow") return;
  try {
    const resp = await ctx.platform.scheduler.run("glue", "StartWorkflowRun", () =>
      client.send(new StartWorkflowRunCommand({ Name: name }))
    );
    void vscode.window.showInformationMessage(`Started workflow "${name}" (run ${resp.RunId?.slice(0, 12) ?? "unknown"}…).`);
    setTimeout(() => { void ctx.refreshPanel().catch(() => { /* best-effort */ }); }, 1500);
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`StartWorkflowRun failed for "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Toggle a Glue trigger: StartTrigger activates a schedule (or fires an
 * ON_DEMAND trigger immediately); StopTrigger deactivates a scheduled
 * trigger. `msg.glueAction` is "start" or "stop".
 */
const glueTriggerToggle: PanelActionHandler = async (msg, ctx) => {
  const action = String(msg.glueAction ?? "");
  if (action !== "start" && action !== "stop") return;
  const ctxOk = await resolveGlueScope(msg.arn as string | undefined, ctx);
  if (!ctxOk) return;
  const { resource, client, name } = ctxOk;
  const tType = String((resource.rawJson as Record<string, unknown>).TriggerType ?? "");
  const onDemand = tType === "ON_DEMAND";
  const verb = action === "start"
    ? (onDemand ? "Fire" : "Activate")
    : "Deactivate";
  const detail = action === "start"
    ? (onDemand
        ? "ON_DEMAND trigger — StartTrigger fires the trigger's actions once. Any downstream jobs/crawlers will be invoked."
        : "Activates the scheduled / conditional trigger so it will fire on its next condition or schedule.")
    : "Deactivates the trigger so it stops firing on its schedule / condition.";
  const confirm = await vscode.window.showWarningMessage(
    `${verb} Glue trigger "${name}"?`,
    { modal: true, detail },
    `${verb} trigger`,
  );
  if (confirm !== `${verb} trigger`) return;
  try {
    if (action === "start") {
      await ctx.platform.scheduler.run("glue", "StartTrigger", () => client.send(new StartTriggerCommand({ Name: name })));
    } else {
      await ctx.platform.scheduler.run("glue", "StopTrigger", () => client.send(new StopTriggerCommand({ Name: name })));
    }
    void vscode.window.showInformationMessage(`${verb} requested for trigger "${name}".`);
    setTimeout(() => { void ctx.refreshPanel().catch(() => { /* best-effort */ }); }, 1500);
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`${verb}Trigger failed for "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Runs an action on a resource ; generic handler so it can be used for any action.
 * Ex : for Ec2 Start/Stop, ECS Scale, RDS Start/Stop, etc ... it will check if the action is available for the resource and then execute the action.
 * @param msg - The message from the webview.
 * @param ctx - The panel action context.
 * @returns A promise that resolves when the action is executed.
 */
const runAction: PanelActionHandler = async (msg, ctx) => {
  if (!msg.arn || !msg.actionId) return;
  const resource = await ctx.platform.resourceRepo.getByArn(msg.arn as string);
  const action = resource ? ctx.platform.actionRegistry.getAction(msg.actionId as string) : undefined;
  if (resource && action) {
    if (!action.isAvailable(resource, ctx.platform)) {
      void vscode.window.showInformationMessage(`"${action.title}" is not available for this resource in its current state.`);
      return;
    }
    await action.execute(resource, ctx.platform);
    if (isEcsScaleActionId(msg.actionId as string)) {
      void scheduleEcsDiscoveryRefreshAfterMutation(ctx.platform, resource, () => ctx.refreshPanel());
    } else if (isEc2StartStopActionId(msg.actionId as string)) {
      void scheduleEc2DiscoveryRefreshAfterMutation(ctx.platform, resource, () => ctx.refreshPanel());
    } else if (isRdsStartStopActionId(msg.actionId as string)) {
      // The RDS action itself already triggers re-discovery (refreshRdsAfterMutation).
      // We just need to reload the panel from SQLite once that's had time to land.
      scheduleRdsPanelRefreshAfterMutation(() => ctx.refreshPanel());
    }
  }
};

const serviceGraph: PanelActionHandler = async (_msg, ctx) => {
  await vscode.commands.executeCommand("cloudView.openServiceGraph", ctx.serviceId);
};

// ─── Dispatch map ────────────────────────────────────────────────────────────

/**
 * Central dispatch map from webview message `type` to handler.
 * The `refresh` type is handled by the panel directly since it owns the
 * resource state and webview lifecycle.
 */
export const PANEL_ACTION_HANDLERS: Record<string, PanelActionHandler> = {
  listMskTopics,
  describeMskTopic,
  mskViewTopics,
  deleteCfnStack,
  executeStateMachine,
  invokeLambda,
  openResource,
  runAction,
  viewLogs,
  logsBrowseStreams,
  viewEcrImages,
  s3BrowsePrefixes,
  sqsViewMessages,
  dynamodbPeekItems,
  cfnViewTemplate,
  cfnWatchEvents,
  cfnViewDependencies,
  ec2StartSession,
  ecsExecCommand,
  apigatewayViewRoutes,
  lbViewHierarchy,
  glueViewRuns,
  glueCrawlerToggle,
  glueWorkflowRun,
  glueTriggerToggle,
  secretViewValue,
  rdsViewHierarchy,
  ecsViewHierarchy,
  serviceGraph,
};
