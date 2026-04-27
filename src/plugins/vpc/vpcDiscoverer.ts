import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEc2Arn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const vpcDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ec2(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ec2", "DescribeVpcs", () =>
        client.send(new DescribeVpcsCommand({ NextToken: nextToken }))
      );

      for (const vpc of response.Vpcs ?? []) {
        const vpcId = vpc.VpcId!;
        const tags = toTagMap(vpc.Tags);
        const name = extractNameTag(tags) ?? vpcId;

        resources.push({
          arn: buildEc2Arn(scope.region, scope.accountId, "vpc", vpcId),
          id: vpcId,
          type: ResourceTypes.vpc,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: vpc as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ec2:DescribeVpcs",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerVpcPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.vpc,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "VPC",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: vpcDiscoverer,
    detailFields: [
      { label: "VPC ID", path: "id", source: "resource" },
      { label: "CIDR", path: "CidrBlock", source: "raw" },
      { label: "State", path: "State", source: "raw" },
      { label: "Is Default", path: "IsDefault", source: "raw" },
    ],
  });
}
