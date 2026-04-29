import {
  ListStacksCommand,
  DescribeStacksCommand,
  type StackSummary,
  type StackStatus,
} from "@aws-sdk/client-cloudformation";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const TERMINAL_STATUSES = new Set<string>([
  "DELETE_COMPLETE",
]);

function timeSinceCreation(creationTime?: Date): number | undefined {
  if (!creationTime) return undefined;
  return Math.floor((Date.now() - creationTime.getTime()) / (1000 * 60 * 60 * 24));
}

function isDriftDetected(status?: string): boolean {
  return status === "DRIFTED";
}

const cfnStackDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.cloudformation(scope);
    const resources: ResourceNode[] = [];

    const summaries: StackSummary[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const response = await platform.scheduler.run("cloudformation", "ListStacks", () =>
        client.send(new ListStacksCommand({ NextToken: nextToken }))
      );

      for (const s of response.StackSummaries ?? []) {
        if (!TERMINAL_STATUSES.has(s.StackStatus ?? "")) {
          summaries.push(s);
        }
      }
      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "cloudformation:ListStacks",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    const batchSize = 20;
    for (let i = 0; i < summaries.length; i += batchSize) {
      const batch = summaries.slice(i, i + batchSize);

      const detailsResponses = await Promise.all(
        batch.map((s) =>
          platform.scheduler.run("cloudformation", "DescribeStacks", () =>
            client.send(new DescribeStacksCommand({ StackName: s.StackId }))
          )
        )
      );

      for (let j = 0; j < batch.length; j++) {
        const summary = batch[j];
        const detail = detailsResponses[j].Stacks?.[0];
        const stackName = summary.StackName ?? "unknown";
        const stackArn = summary.StackId ?? `arn:aws:cloudformation:${scope.region}:${scope.accountId}:stack/${stackName}`;

        const tags = toTagMap(detail?.Tags);
        const status = (detail?.StackStatus ?? summary.StackStatus ?? "UNKNOWN") as StackStatus;
        const outputs = detail?.Outputs ?? [];
        const parameters = detail?.Parameters ?? [];

        const enriched: Record<string, unknown> = {
          StackName: stackName,
          StackStatus: status,
          StackStatusReason: detail?.StackStatusReason ?? summary.StackStatusReason,
          CreationTime: detail?.CreationTime?.toISOString() ?? summary.CreationTime?.toISOString(),
          LastUpdatedTime: detail?.LastUpdatedTime?.toISOString() ?? summary.LastUpdatedTime?.toISOString(),
          Description: detail?.Description ?? summary.TemplateDescription,
          RoleARN: detail?.RoleARN,
          DisableRollback: detail?.DisableRollback,
          EnableTerminationProtection: detail?.EnableTerminationProtection,
          DriftStatus: detail?.DriftInformation?.StackDriftStatus,
          LastDriftCheckTime: detail?.DriftInformation?.LastCheckTimestamp?.toISOString(),
          IsDriftDetected: isDriftDetected(detail?.DriftInformation?.StackDriftStatus),
          ParentStackId: detail?.ParentId,
          RootStackId: detail?.RootId,
          IsNestedStack: Boolean(detail?.ParentId),
          OutputCount: outputs.length,
          ParameterCount: parameters.length,
          AgeDays: timeSinceCreation(detail?.CreationTime ?? summary.CreationTime),
          NotificationARNs: detail?.NotificationARNs,
          Capabilities: detail?.Capabilities?.join(", ") || "None",
          Outputs: outputs.map((o) => ({ Key: o.OutputKey, Value: o.OutputValue, Description: o.Description })),
          Parameters: parameters.map((p) => ({ Key: p.ParameterKey, Value: p.ParameterValue })),
        };

        const statusStr = String(status);
        let state: string;
        if (statusStr.endsWith("_COMPLETE") && !statusStr.includes("DELETE") && !statusStr.includes("ROLLBACK")) {
          state = "active";
        } else if (statusStr.includes("IN_PROGRESS")) {
          state = "pending";
        } else if (statusStr.includes("FAILED") || statusStr.includes("ROLLBACK")) {
          state = "failed";
        } else {
          state = statusStr.toLowerCase();
        }

        resources.push({
          arn: stackArn,
          id: stackName,
          type: ResourceTypes.cfnStack,
          service: "cloudformation",
          accountId: scope.accountId,
          region: scope.region,
          name: stackName,
          tags,
          rawJson: enriched,
          lastUpdated: Date.now(),
        });
      }
    }

    return resources;
  },
};

export function registerCfnStackPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.cfnStack,
    service: "cloudformation",
    serviceLabel: "CloudFormation",
    displayName: "CloudFormation Stack",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: cfnStackDiscoverer,
    getTreeDescription: (resource) => resource.rawJson.StackStatus as string | undefined,
    buildConsoleUrl: (resource) => {
      const region = resource.region;
      const encodedArn = encodeURIComponent(resource.arn);
      return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodedArn}`;
    },
    buildCliDescribeCommand: (resource) => {
      return `aws cloudformation describe-stacks --stack-name "${resource.name}" --region ${resource.region}`;
    },
  });
}
