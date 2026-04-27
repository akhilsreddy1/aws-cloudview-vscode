import { DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEc2Arn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const subnetDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ec2(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ec2", "DescribeSubnets", () =>
        client.send(new DescribeSubnetsCommand({ NextToken: nextToken }))
      );

      for (const subnet of response.Subnets ?? []) {
        const subnetId = subnet.SubnetId!;
        const tags = toTagMap(subnet.Tags);
        const name = extractNameTag(tags) ?? subnetId;

        resources.push({
          arn: buildEc2Arn(scope.region, scope.accountId, "subnet", subnetId),
          id: subnetId,
          type: ResourceTypes.subnet,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: subnet as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ec2:DescribeSubnets",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerSubnetPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.subnet,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "Subnet",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: subnetDiscoverer,
    detailFields: [
      { label: "Subnet ID", path: "id", source: "resource" },
      { label: "Availability Zone", path: "AvailabilityZone", source: "raw" },
      { label: "CIDR", path: "CidrBlock", source: "raw" },
      { label: "VPC", path: "VpcId", source: "raw" },
    ],
  });
}
