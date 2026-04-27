import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEc2Arn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const OLD_GEN_PREFIXES = [
  "t1.", "t2.", "m1.", "m2.", "m3.", "m4.",
  "c1.", "c3.", "c4.", "r3.", "r4.",
  "i2.", "d2.", "g2.", "p2.",
];

function isOldGeneration(instanceType: string): boolean {
  return OLD_GEN_PREFIXES.some((p) => instanceType.startsWith(p));
}

const instanceDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ec2(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ec2", "DescribeInstances", () =>
        client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
      );

      for (const reservation of response.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const instanceId = instance.InstanceId!;
          const tags = toTagMap(instance.Tags);
          const name = extractNameTag(tags) ?? instanceId;

          const instanceType = instance.InstanceType ?? "";
          const launchTime = instance.LaunchTime;
          const ageDays = launchTime
            ? Math.floor((Date.now() - new Date(launchTime).getTime()) / 86_400_000)
            : undefined;

          const raw = instance as Record<string, unknown>;
          const creditSpec = (raw.CreditSpecification as Record<string, unknown> | undefined)?.CpuCredits;

          const enriched: Record<string, unknown> = {
            ...raw,
            AgeDays: ageDays, // Custom field to indicate how long the instance has been running
            IsOldGeneration: isOldGeneration(instanceType),
            EbsOptimized: instance.EbsOptimized ?? false,
            CpuCredits: creditSpec,
          };

          resources.push({
            arn: buildEc2Arn(scope.region, scope.accountId, "instance", instanceId),
            id: instanceId,
            type: ResourceTypes.ec2Instance,
            service: "ec2",
            accountId: scope.accountId,
            region: scope.region,
            name,
            tags,
            rawJson: enriched,
            lastUpdated: Date.now(),
          });
        }
      }

      nextToken = response.NextToken;
      pages++;
      // Check if we should stop pagination to avoid long-running discovery sessions, especially in accounts with many resources
      if (shouldStopPagination({
        pages, nextToken, label: "ec2:DescribeInstances",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerEc2InstancePlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.ec2Instance,
    service: "ec2",
    serviceLabel: "EC2",
    displayName: "EC2 Instance",
    scope: "regional",
    ttlSeconds: 180,
    discoverer: instanceDiscoverer,
    getTreeDescription: (resource) => {
      const instanceType = resource.rawJson.InstanceType as string | undefined;
      const stateName = (resource.rawJson.State as Record<string, unknown> | undefined)?.Name as string | undefined;
      return instanceType ?? stateName;
    },
  });
}
