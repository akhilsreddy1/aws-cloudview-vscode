import * as vscode from "vscode";
import { ListTopicsCommand } from "@aws-sdk/client-kafka";
import { DeleteStackCommand } from "@aws-sdk/client-cloudformation";
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
    const message = err instanceof Error ? err.message : String(err);
    await ctx.postMessage({ type: "mskTopicsResult", clusterArn, topics: [], error: message });
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
  serviceGraph,
};
