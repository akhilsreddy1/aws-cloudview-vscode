import { DescribeClustersCommand } from "@aws-sdk/client-redshift";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildRedshiftArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const redshiftDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.redshift(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("redshift", "DescribeClusters", () =>
        client.send(new DescribeClustersCommand({ Marker: marker }))
      );

      for (const cluster of response.Clusters ?? []) {
        const clusterId = cluster.ClusterIdentifier!;
        const tags = toTagMap(cluster.Tags);
        const name = extractNameTag(tags) ?? clusterId;

        resources.push({
          arn: buildRedshiftArn(scope.region, scope.accountId, clusterId),
          id: clusterId,
          type: ResourceTypes.redshiftCluster,
          service: "redshift",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: cluster as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      marker = response.Marker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "redshift:DescribeClusters",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

export function registerRedshiftPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.redshiftCluster,
    service: "redshift",
    serviceLabel: "Redshift",
    displayName: "Redshift Cluster",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: redshiftDiscoverer,
    detailFields: [
      { label: "Cluster ID", path: "id", source: "resource" },
      { label: "Node Type", path: "NodeType", source: "raw" },
      { label: "Status", path: "ClusterStatus", source: "raw" },
      { label: "DB Name", path: "DBName", source: "raw" },
      { label: "Number of Nodes", path: "NumberOfNodes", source: "raw" },
    ],
  });
}
