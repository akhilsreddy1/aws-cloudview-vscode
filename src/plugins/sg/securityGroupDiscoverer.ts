import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEc2Arn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const securityGroupDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ec2(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ec2", "DescribeSecurityGroups", () =>
        client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }))
      );

      for (const sg of response.SecurityGroups ?? []) {
        const groupId = sg.GroupId!;
        const tags = toTagMap(sg.Tags);
        const name = extractNameTag(tags) ?? sg.GroupName ?? groupId;

        resources.push({
          arn: buildEc2Arn(scope.region, scope.accountId, "security-group", groupId),
          id: groupId,
          type: ResourceTypes.securityGroup,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: sg as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ec2:DescribeSecurityGroups",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerSecurityGroupPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.securityGroup,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "Security Group",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: securityGroupDiscoverer,
    detailFields: [
      { label: "Group ID", path: "id", source: "resource" },
      { label: "Group Name", path: "GroupName", source: "raw" },
      { label: "Description", path: "Description", source: "raw" },
      { label: "VPC", path: "VpcId", source: "raw" },
    ],
  });
}
