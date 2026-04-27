import * as vscode from "vscode";
import { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import {
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from "@aws-sdk/client-rds";
import { StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import type { ResourceAction, ResourceNode } from "../core/contracts";
import type { CloudViewPlatform } from "../core/platform";
import { ResourceTypes } from "../core/resourceTypes";
import { buildGenericConsoleUrl } from "../core/resourceUtils";


/**
 * Registry of all {@link ResourceAction} objects available in the extension.
 * Actions are keyed by their unique `id`. Callers use
 * {@link getActionsForResource} to retrieve the filtered, sorted list of
 * actions applicable to a specific resource.
 *
 * @example
 * ```ts
 * actionRegistry.register({
 *   type: ResourceTypes.SomeResourceType,
 *   title: "Some Action",
 *   order: 1,
 *   isAvailable: (resource, platform) => true,
 *   execute: async (resource, platform) => {
 *     // Action implementation here
 *   }
 * });
 * ```
 */
export class ActionRegistry {
  private readonly actions = new Map<string, ResourceAction>();

  public register(action: ResourceAction): void {
    this.actions.set(action.id, action);
  }

  /**
   * Returns all actions where isAvailable returns true
   * for the given resource, sorted by `order` (ascending, default 100).
   * Ex: if the resource is an ECS service, get the actions for the ECS service from the action registry
   */
  public getActionsForResource(resource: ResourceNode, platform: CloudViewPlatform): ResourceAction[] {
    return Array.from(this.actions.values())
      .filter((action) => action.isAvailable(resource, platform))
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100));
  }

  public getAction(id: string): ResourceAction | undefined {
    return this.actions.get(id);
  }
}

/**
 * Registers the built-in default actions for the resource types.
 * Some actions are available for all resource types, some are available for specific resource types.
 * ECS and EC2 are registered separately from the default actions to keep the code cleaner and more readable.
 */
export function registerDefaultActions(actionRegistry: ActionRegistry): void {
  actionRegistry.register({
    id: "cloudView.copyArn",
    title: "Copy ARN",
    order: 1,
    isAvailable: (resource) => Boolean(resource.arn),
    execute: async (resource) => {
      await vscode.env.clipboard.writeText(resource.arn);
      void vscode.window.setStatusBarMessage(`Copied ARN for ${resource.name}`, 2500);
    }
  });

  actionRegistry.register({
    id: "cloudView.openInConsole",
    title: "Open in AWS Console",
    order: 2,
    isAvailable: (resource) => Boolean(resource.arn),
    execute: async (resource, platform) => {
      const typeSpecific = platform.resourceRegistry.get(resource.type)?.buildConsoleUrl?.(resource);
      const url = typeSpecific ?? buildGenericConsoleUrl(resource);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });

  actionRegistry.register({
    id: "cloudView.copyCliDescribe",
    title: "Copy AWS CLI describe command",
    order: 3,
    isAvailable: (resource, platform) => Boolean(platform.resourceRegistry.get(resource.type)?.buildCliDescribeCommand?.(resource)),
    execute: async (resource, platform) => {
      const command = platform.resourceRegistry.get(resource.type)?.buildCliDescribeCommand?.(resource);
      if (!command) {
        throw new Error(`No CLI describe builder registered for ${resource.type}`);
      }

      await vscode.env.clipboard.writeText(command);
      void vscode.window.setStatusBarMessage(`Copied AWS CLI command for ${resource.name}`, 2500);
    }
  });

  actionRegistry.register({
    id: "cloudView.invokeLambda",
    title: "\u25B6 Invoke Lambda",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.lambdaFunction,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.invokeLambda", resource.arn);
    }
  });

  actionRegistry.register({
    id: "cloudView.ec2.copySsmCommand",
    title: "Copy SSM start-session command",
    order: 4,
    isAvailable: (resource) => resource.type === ResourceTypes.ec2Instance,
    execute: async (resource) => {
      const cmd = `aws ssm start-session --target ${resource.id} --region ${resource.region}`;
      await vscode.env.clipboard.writeText(cmd);
      void vscode.window.setStatusBarMessage(`Copied SSM command for ${resource.name || resource.id}`, 2500);
    }
  });

  // S3 — browse prefixes ("folders") + upload into the current prefix ; no individual objects list .
  actionRegistry.register({
    id: "cloudView.s3.browsePrefixes",
    title: "\u{1F4C2} Browse & Upload",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.s3Bucket,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.s3.browsePrefixes", resource.arn);
    }
  });

  // ECR — open a webview listing image tags in this repository with the ability to delete individual tags.
  actionRegistry.register({
    id: "cloudView.ecr.viewImages",
    title: "View Image Tags",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.ecrRepository,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.ecr.viewImages", resource.arn);
    }
  });

  // CloudWatch Logs — browse log streams in a group and search the group's events with a CloudWatch filter-pattern.
  actionRegistry.register({
    id: "cloudView.logs.browseStreams",
    title: "\uD83D\uDCDC Browse Streams & Search",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.logGroup,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.logs.browseStreams", resource.arn);
    }
  });

  // ECS Task / Service — open a panel rendering the underlying task definition
  // (container list, images, env, CPU/memory, exec role).
  actionRegistry.register({
    id: "cloudView.ecs.viewTaskDef",
    title: "View Task Definition",
    order: 5,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.ecsTask || resource.type === ResourceTypes.ecsService,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.ecs.viewTaskDef", resource.arn);
    }
  });

  // SQS — open the message viewer (peek + redrive if this is a DLQ).
  actionRegistry.register({
    id: "cloudView.sqs.viewMessages",
    title: "\u{1F4EC} View Messages / Redrive",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.sqsQueue,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.sqs.viewMessages", resource.arn);
    }
  });

  // DynamoDB — open the item viewer (Scan / Query latest, non-destructive).
  actionRegistry.register({
    id: "cloudView.dynamodb.peekItems",
    title: "\u{1F50D} Peek Items",
    order: 0,
    isAvailable: (resource) => resource.type === ResourceTypes.dynamodbTable,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.dynamodb.peekItems", resource.arn);
    }
  });

  // Public-exposure check — runs a service-specific read-only audit for
  // resources that are commonly misconfigured (S3 buckets, security groups,
  // ALBs, RDS). Opens a findings panel.
  actionRegistry.register({
    id: "cloudView.checkPublicExposure",
    title: "Check Public Exposure",
    order: 6,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.s3Bucket ||
      resource.type === ResourceTypes.securityGroup ||
      resource.type === ResourceTypes.alb ||
      resource.type === ResourceTypes.rdsInstance ||
      resource.type === ResourceTypes.rdsCluster,
    execute: async (resource) => {
      await vscode.commands.executeCommand("cloudView.checkPublicExposure", resource.arn);
    }
  });

}

function rdsClusterStatusNorm(resource: ResourceNode): string {
  const raw = resource.rawJson as Record<string, unknown> | undefined;
  const s = raw?.Status ?? raw?.ClusterStatus ?? "";
  return String(s).trim().toLowerCase();
}

function rdsInstanceStatusNorm(resource: ResourceNode): string {
  const s = (resource.rawJson as Record<string, unknown> | undefined)?.DBInstanceStatus ?? "";
  return String(s).trim().toLowerCase();
}

function rdsInstanceInCluster(resource: ResourceNode): boolean {
  const cid = (resource.rawJson as Record<string, unknown> | undefined)?.DBClusterIdentifier;
  return cid !== undefined && cid !== null && String(cid).length > 0;
}

async function refreshRdsAfterMutation(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
  const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
  if (!profileName) {
    return;
  }
  const scope = { profileName, accountId: resource.accountId, region: resource.region };
  setTimeout(() => {
    void platform.discoveryCoordinator.refreshServiceScope(scope, "rds", { force: true }).catch(() => {
      /* best-effort refresh */
    });
  }, 1500);
}

const ECS_SCALE_ACTION_IDS = new Set<string>(["cloudView.ecs.scaleToZero", "cloudView.ecs.scaleFromZero"]);
const EC2_START_STOP_ACTION_IDS = new Set<string>(["cloudView.ec2.start", "cloudView.ec2.stop"]);
const RDS_START_STOP_ACTION_IDS = new Set<string>([
  "cloudView.rds.startCluster",
  "cloudView.rds.stopCluster",
  "cloudView.rds.startInstance",
  "cloudView.rds.stopInstance",
]);

/**
 * @returns `true` for ECS service scale in/out actions; callers can chain UI refresh
 * (e.g. service dashboard) after a scoped ECS discovery, matching CloudFormation delete flow.
 */
export function isEcsScaleActionId(actionId: string): boolean {
  return ECS_SCALE_ACTION_IDS.has(actionId);
}

/** @returns `true` for EC2 instance start/stop actions. */
export function isEc2StartStopActionId(actionId: string): boolean {
  return EC2_START_STOP_ACTION_IDS.has(actionId);
}

/** @returns `true` for RDS cluster/instance start/stop actions. */
export function isRdsStartStopActionId(actionId: string): boolean {
  return RDS_START_STOP_ACTION_IDS.has(actionId);
}

/**
 * Schedule a panel reload after an RDS start/stop. The action itself already
 * kicks off discovery via {@link refreshRdsAfterMutation} (1.5s delay); we
 * additionally run `ctx.refreshPanel()` ~3.5s later so the dashboard re-reads
 * the now-updated SQLite rows. RDS state transitions
 * (`available` → `stopping` → `stopped`) typically take a few seconds.
 */
export function scheduleRdsPanelRefreshAfterMutation(
  onAfterScopeRefresh: () => void | Promise<void>,
): void {
  setTimeout(() => {
    void Promise.resolve(onAfterScopeRefresh()).catch(() => { /* best-effort */ });
  }, 3500);
}

/**
 * Re-run EC2 discovery for the resource's account/region after a start/stop
 * mutation, then run an optional callback (e.g. reload the dashboard from
 * SQLite). Mirrors {@link scheduleEcsDiscoveryRefreshAfterMutation}. The 3s
 * delay is longer than ECS because EC2 state transitions (`pending` →
 * `running`, `stopping` → `stopped`) typically take a few seconds.
 */
export function scheduleEc2DiscoveryRefreshAfterMutation(
  platform: CloudViewPlatform,
  resource: ResourceNode,
  onAfterScopeRefresh?: () => void | Promise<void>
): void {
  setTimeout(() => {
    void (async () => {
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) return;
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        await platform.discoveryCoordinator.refreshServiceScope(scope, "ec2", { force: true });
        if (onAfterScopeRefresh) await onAfterScopeRefresh();
      } catch {
        /* best-effort; cache may be partly stale on failure */
      }
    })();
  }, 3000);
}

/**
 * Re-run ECS discovery for the resource’s account/region (same as {@linkcode refreshEcsAfterMutation} before),
 * then optional callback (e.g. reload a webview from SQLite) — see CloudView `deleteCfnStack` handler.
 */
export function scheduleEcsDiscoveryRefreshAfterMutation(
  platform: CloudViewPlatform,
  resource: ResourceNode,
  onAfterScopeRefresh?: () => void | Promise<void>
): void {
  setTimeout(() => {
    void (async () => {
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        await platform.discoveryCoordinator.refreshServiceScope(scope, "ecs", { force: true });
        if (onAfterScopeRefresh) {
          await onAfterScopeRefresh();
        }
      } catch {
        /* best-effort; cache may be partly stale on failure */
      }
    })();
  }, 1500);
}

function ecsServiceUpdateContext(
  resource: ResourceNode
): { clusterArn: string; serviceName: string } | undefined {
  const raw = resource.rawJson as { clusterArn?: string; serviceName?: string } | undefined;
  const clusterArn = String(raw?.clusterArn ?? "");
  const serviceName = String(raw?.serviceName ?? resource.id ?? "").trim();
  if (!clusterArn || !serviceName) {
    return undefined;
  }
  return { clusterArn, serviceName };
}

function ecsServiceDesiredCount(resource: ResourceNode): number | undefined {
  if (resource.type !== ResourceTypes.ecsService) {
    return undefined;
  }
  const raw = resource.rawJson as { desiredCount?: number } | undefined;
  const dc = Number(raw?.desiredCount);
  return Number.isNaN(dc) ? undefined : dc;
}

/**
 * Adding ECS scale actions to the action registry, keeping it outside for better organization and readability.
 */
export function registerEcsActions(actionRegistry: ActionRegistry): void {
  actionRegistry.register({
    id: "cloudView.ecs.scaleToZero",
    title: "Scale in (desired count \u2192 0)",
    order: 2,
    isAvailable: (resource) => {
      if (resource.type !== ResourceTypes.ecsService) {
        return false;
      }
      const dc = ecsServiceDesiredCount(resource);
      return dc !== undefined && dc > 0;
    },
    execute: async (resource, platform) => {
      const ctx = ecsServiceUpdateContext(resource);
      if (!ctx) {
        void vscode.window.showErrorMessage("Missing cluster or service name. Refresh the ECS dashboard and try again.");
        return;
      }
      const { clusterArn, serviceName } = ctx;
      const current = ecsServiceDesiredCount(resource) ?? 0;
      const picked = await vscode.window.showWarningMessage(
        `Scale in ECS service "${resource.name || serviceName}"?`,
        {
          modal: true,
          detail: `This sets desired count from ${current} to 0. Running tasks will be stopped (per deployment configuration, including drain).`,
        },
        "Scale in to 0"
      );
      if (picked !== "Scale in to 0") {
        return;
      }
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.ecs(scope);
        await platform.scheduler.run("ecs", "UpdateService", () =>
          client.send(
            new UpdateServiceCommand({
              cluster: clusterArn,
              service: serviceName,
              desiredCount: 0,
            })
          )
        );
        void vscode.window.showInformationMessage(
          `Update requested: "${serviceName}" desired count set to 0. Refreshing soon…`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to update ECS service: ${message}`);
      }
    },
  });

  actionRegistry.register({
    id: "cloudView.ecs.scaleFromZero",
    title: "Scale out (set desired count)",
    order: 3,
    isAvailable: (resource) => {
      if (resource.type !== ResourceTypes.ecsService) {
        return false;
      }
      const dc = ecsServiceDesiredCount(resource);
      return dc === 0;
    },
    execute: async (resource, platform) => {
      const ctx = ecsServiceUpdateContext(resource);
      if (!ctx) {
        void vscode.window.showErrorMessage("Missing cluster for this ECS service. Refresh the ECS dashboard and try again.");
        return;
      }
      const { clusterArn, serviceName } = ctx;

      const input = await vscode.window.showInputBox({
        title: "Scale ECS service",
        prompt: "Desired number of running tasks (current desired count is 0)",
        value: "1",
        validateInput: (v) => {
          const n = parseInt(v, 10);
          if (Number.isNaN(n) || n < 1) {
            return "Enter an integer >= 1";
          }
          if (n > 10_000) {
            return "Value too large";
          }
          return undefined;
        },
      });
      if (input === undefined) {
        return;
      }
      const desiredCount = parseInt(input, 10);
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.ecs(scope);
        await platform.scheduler.run("ecs", "UpdateService", () =>
          client.send(
            new UpdateServiceCommand({
              cluster: clusterArn,
              service: serviceName,
              desiredCount,
            })
          )
        );
        void vscode.window.showInformationMessage(
          `Update requested: "${serviceName}" desired count set to ${desiredCount}. Tasks will start per your service definition. Refreshing soon…`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to update ECS service: ${message}`);
      }
    },
  });
}

/**
 * Helpers for EC2 instance lifecycle state. Reads `State.Name` from the raw
 * DescribeInstances payload — the canonical AWS field for current lifecycle
 * state (`pending`, `running`, `stopping`, `stopped`, `shutting-down`,
 * `terminated`).
 */
function ec2InstanceState(resource: ResourceNode): string {
  if (resource.type !== ResourceTypes.ec2Instance) return "";
  const raw = resource.rawJson as { State?: { Name?: unknown } } | undefined;
  const name = raw?.State?.Name;
  return typeof name === "string" ? name.toLowerCase() : "";
}

/**
 * Start/stop for EC2 instances. We never expose Terminate here — that's
 * destructive in a way Start/Stop are not, and termination is intentionally
 * left to the AWS console. State transitions are eventually consistent, so
 * after a successful API call we kick off a delayed re-discovery via
 * {@link scheduleEc2DiscoveryRefreshAfterMutation}.
 */
export function registerEc2Actions(actionRegistry: ActionRegistry): void {
  actionRegistry.register({
    id: "cloudView.ec2.start",
    title: "Start instance",
    order: 4,
    isAvailable: (resource) => ec2InstanceState(resource) === "stopped",
    execute: async (resource, platform) => {
      const instanceId = resource.id;
      if (!instanceId) {
        void vscode.window.showErrorMessage("Missing instance ID. Refresh the EC2 dashboard and try again.");
        return;
      }
      const picked = await vscode.window.showWarningMessage(
        `Start EC2 instance "${resource.name || instanceId}"?`,
        {
          modal: true,
          detail: `Region: ${resource.region}\nAccount: ${resource.accountId}\n\nThe instance will boot and you'll be charged compute hours until it's stopped again.`,
        },
        "Start instance"
      );
      if (picked !== "Start instance") return;

      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.ec2(scope);
        await platform.scheduler.run("ec2", "StartInstances", () =>
          client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
        );
        void vscode.window.showInformationMessage(
          `Start requested for "${resource.name || instanceId}". Refreshing soon…`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start instance: ${message}`);
      }
    },
  });

  actionRegistry.register({
    id: "cloudView.ec2.stop",
    title: "Stop instance",
    order: 5,
    isAvailable: (resource) => ec2InstanceState(resource) === "running",
    execute: async (resource, platform) => {
      const instanceId = resource.id;
      if (!instanceId) {
        void vscode.window.showErrorMessage("Missing instance ID. Refresh the EC2 dashboard and try again.");
        return;
      }
      const picked = await vscode.window.showWarningMessage(
        `Stop EC2 instance "${resource.name || instanceId}"?`,
        {
          modal: true,
          detail: `Region: ${resource.region}\nAccount: ${resource.accountId}\n\nApplications on the instance will be terminated. Instance-store volumes (if any) will be lost. EBS volumes are preserved.`,
        },
        "Stop instance"
      );
      if (picked !== "Stop instance") return;

      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.ec2(scope);
        await platform.scheduler.run("ec2", "StopInstances", () =>
          client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
        );
        void vscode.window.showInformationMessage(
          `Stop requested for "${resource.name || instanceId}". Refreshing soon…`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to stop instance: ${message}`);
      }
    },
  });
}

/**
 * Start/stop for Aurora DB clusters and for standalone RDS DB instances (not Aurora members).
 */
export function registerRdsActions(actionRegistry: ActionRegistry): void {
  actionRegistry.register({
    id: "cloudView.rds.stopCluster",
    title: "Stop DB cluster",
    order: 8,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.rdsCluster &&
      ["available", "backing-up"].includes(rdsClusterStatusNorm(resource)),
    execute: async (resource, platform) => {
      const picked = await vscode.window.showWarningMessage(
        `Stop RDS DB cluster "${resource.name}"?`,
        {
          modal: true,
          detail: "The cluster and its writer/reader instances will shut down. You can start the cluster again from CloudView when it is stopped.",
        },
        "Stop cluster"
      );
      if (picked !== "Stop cluster") {
        return;
      }
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.rds(scope);
        await platform.scheduler.run("rds", "StopDBCluster", () =>
          client.send(new StopDBClusterCommand({ DBClusterIdentifier: resource.id }))
        );
        void vscode.window.showInformationMessage(`Stop requested for cluster "${resource.name}".`);
        // Notify the user that the stop operation has been initiated and that the panel will refresh shortly
        await refreshRdsAfterMutation(platform, resource);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to stop cluster: ${message}`);
      }
    },
  });

  actionRegistry.register({
    id: "cloudView.rds.startCluster",
    title: "Start DB cluster",
    order: 9,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.rdsCluster && rdsClusterStatusNorm(resource) === "stopped",
    execute: async (resource, platform) => {
      const picked = await vscode.window.showInformationMessage(
        `Start RDS DB cluster "${resource.name}"?`,
        { modal: true, detail: "This starts the cluster and its instances." },
        "Start cluster"
      );
      if (picked !== "Start cluster") {
        return;
      }
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.rds(scope);
        await platform.scheduler.run("rds", "StartDBCluster", () =>
          client.send(new StartDBClusterCommand({ DBClusterIdentifier: resource.id }))
        );
        void vscode.window.showInformationMessage(`Start requested for cluster "${resource.name}".`);
        await refreshRdsAfterMutation(platform, resource);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start cluster: ${message}`);
      }
    },
  });

  actionRegistry.register({
    id: "cloudView.rds.stopInstance",
    title: "Stop DB instance",
    order: 10,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.rdsInstance &&
      !rdsInstanceInCluster(resource) &&
      ["available", "storage-optimization"].includes(rdsInstanceStatusNorm(resource)),
    execute: async (resource, platform) => {
      const picked = await vscode.window.showWarningMessage(
        `Stop RDS DB instance "${resource.name}"?`,
        {
          modal: true,
          detail: "This does not apply to Aurora cluster members — stop the DB cluster instead. Stopped instances restart automatically after several days unless you start them first.",
        },
        "Stop instance"
      );
      if (picked !== "Stop instance") {
        return;
      }
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.rds(scope);
        await platform.scheduler.run("rds", "StopDBInstance", () =>
          client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: resource.id }))
        );
        void vscode.window.showInformationMessage(`Stop requested for instance "${resource.name}".`);
        await refreshRdsAfterMutation(platform, resource);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to stop instance: ${message}`);
      }
    },
  });

  actionRegistry.register({
    id: "cloudView.rds.startInstance",
    title: "Start DB instance",
    order: 11,
    isAvailable: (resource) =>
      resource.type === ResourceTypes.rdsInstance &&
      !rdsInstanceInCluster(resource) &&
      rdsInstanceStatusNorm(resource) === "stopped",
    execute: async (resource, platform) => {
      const picked = await vscode.window.showInformationMessage(
        `Start RDS DB instance "${resource.name}"?`,
        { modal: true },
        "Start instance"
      );
      if (picked !== "Start instance") {
        return;
      }
      const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
      if (!profileName) {
        void vscode.window.showErrorMessage("No AWS profile resolved for this account.");
        return;
      }
      const scope = { profileName, accountId: resource.accountId, region: resource.region };
      try {
        const client = await platform.awsClientFactory.rds(scope);
        await platform.scheduler.run("rds", "StartDBInstance", () =>
          client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: resource.id }))
        );
        void vscode.window.showInformationMessage(`Start requested for instance "${resource.name}".`);
        await refreshRdsAfterMutation(platform, resource);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to start instance: ${message}`);
      }
    },
  });
}
