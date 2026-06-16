import { DescribeVpcEndpointsCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEc2Arn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const vpcEndpointDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ec2(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ec2", "DescribeVpcEndpoints", () =>
        client.send(new DescribeVpcEndpointsCommand({ NextToken: nextToken }))
      );

      for (const ep of response.VpcEndpoints ?? []) {
        const id = ep.VpcEndpointId!;
        const tags = toTagMap(ep.Tags);
        const name = extractNameTag(tags) ?? id;

        resources.push({
          arn: buildEc2Arn(scope.region, scope.accountId, "vpc-endpoint", id),
          id,
          type: ResourceTypes.vpcEndpoint,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: ep as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ec2:DescribeVpcEndpoints",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerVpcEndpointPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.vpcEndpoint,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "VPC Endpoint",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: vpcEndpointDiscoverer,
    detailFields: [
      { label: "Endpoint ID", path: "id", source: "resource" },
      { label: "VPC", path: "VpcId", source: "raw" },
      { label: "Service name", path: "ServiceName", source: "raw" },
      { label: "Type", path: "VpcEndpointType", source: "raw" },
      { label: "State", path: "State", source: "raw" },
    ],
  });
}
