import {
  DescribeLogGroupsCommand,
  type LogGroup,
} from "@aws-sdk/client-cloudwatch-logs";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildLogGroupArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Discovers CloudWatch log groups in a region.
 *
 * For each group returned by `DescribeLogGroups` we flatten key fields onto
 * `rawJson` so the service-detail column config can surface them directly:
 * retention, stored-bytes size, KMS encryption, creation date, and a
 * human-readable "has-retention" boolean used by the dashboard tabs.
 *
 * Tags aren't fetched here — `ListTagsLogGroup` is 1 call per group and
 * log groups are easily in the hundreds per account. Tag data is lazy-
 * loaded by the stream browser panel when needed.
 */
const logsDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.cloudwatchLogs(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("logs", "DescribeLogGroups", () =>
        client.send(new DescribeLogGroupsCommand({ nextToken, limit: 25 }))
      );

      for (const group of response.logGroups ?? []) {
        const name = group.logGroupName;
        if (!name) { continue; }
        const arn = group.arn ?? buildLogGroupArn(scope.region, scope.accountId, name);

        const flat = flattenLogGroup(group);
        resources.push({
          arn,
          id: name,
          type: ResourceTypes.logGroup,
          service: "logs",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags: {},
          rawJson: flat,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.nextToken;
      pages++;
      // If the discoverer is taking a long time to paginate, check if we should stop to keep the UI responsive
      if (shouldStopPagination({
        pages, nextToken, label: "logs:DescribeLogGroups",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

function flattenLogGroup(group: LogGroup): Record<string, unknown> {
  const retentionDays = group.retentionInDays;
  const storedBytes = group.storedBytes ?? 0;
  const source = categorizeSource(group.logGroupName ?? "");
  return {
    ...(group as unknown as Record<string, unknown>),
    LogGroupName: group.logGroupName,
    RetentionInDays: retentionDays,
    HasRetention: retentionDays !== undefined && retentionDays > 0,
    StoredBytes: storedBytes,
    IsEncrypted: Boolean(group.kmsKeyId),
    KmsKeyId: group.kmsKeyId,
    CreationTime: group.creationTime,
    LogClass: group.logGroupClass ?? "STANDARD",
    Source: source,
  };
}

/**
 * Infer which AWS service emits into this log group from its name. Almost
 * every managed service writes to a well-known prefix — surfacing that
 * upfront lets users filter by source (Lambda / ECS / API Gateway / etc.)
 * without paying for an extra AWS call.
 */
function categorizeSource(name: string): string {
  if (name.startsWith("/aws/lambda/")) { return "Lambda"; }
  if (name.startsWith("/aws/apigateway/") || name.startsWith("API-Gateway-Execution-Logs_")) { return "API Gateway"; }
  if (name.startsWith("/aws/ecs/")) { return "ECS"; }
  if (name.startsWith("/ecs/")) { return "ECS"; }
  if (name.startsWith("/aws/codebuild/")) { return "CodeBuild"; }
  if (name.startsWith("/aws/rds/") || name.startsWith("/aws/rds-")) { return "RDS"; }
  if (name.startsWith("/aws/redshift/")) { return "Redshift"; }
  if (name.startsWith("/aws/eks/")) { return "EKS"; }
  if (name.startsWith("/aws/vpc/") || name.startsWith("/aws/vpc-flow-logs/")) { return "VPC"; }
  if (name.startsWith("/aws/vendedlogs/")) { return "Vended Logs"; }
  if (name.startsWith("/aws/events/")) { return "EventBridge"; }
  if (name.startsWith("/aws/states/") || name.startsWith("/aws/vendedlogs/states/")) { return "Step Functions"; }
  if (name.startsWith("/aws/cloudtrail/") || name.toLowerCase().includes("cloudtrail")) { return "CloudTrail"; }
  if (name.startsWith("/aws/route53/") || name.startsWith("/aws/route53-")) { return "Route 53"; }
  if (name.startsWith("/aws/")) { return "AWS Service"; }
  return "Custom";
}

export function registerLogsPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.logGroup,
    service: "logs",
    serviceLabel: "CloudWatch Logs",
    displayName: "Log Group",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: logsDiscoverer,
    detailFields: [
      { label: "Log Group Name", path: "id", source: "resource" },
      { label: "Retention (days)", path: "RetentionInDays", source: "raw" },
      { label: "Stored Bytes", path: "StoredBytes", source: "raw" },
      { label: "Log Class", path: "LogClass", source: "raw" },
      { label: "KMS Key", path: "KmsKeyId", source: "raw" },
      { label: "Source", path: "Source", source: "raw" },
      { label: "Created", path: "CreationTime", source: "raw" },
    ],
    getTreeDescription: (resource) => {
      const retention = resource.rawJson.RetentionInDays as number | undefined;
      const source = resource.rawJson.Source as string | undefined;
      const retentionLabel = retention ? `${retention}d` : "∞";
      return source ? `${source} · ${retentionLabel}` : retentionLabel;
    },
  });
}
