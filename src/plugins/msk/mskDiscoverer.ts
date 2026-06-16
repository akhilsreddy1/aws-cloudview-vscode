import { ListClustersV2Command, DescribeClusterV2Command } from "@aws-sdk/client-kafka";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { shouldStopPagination } from "../../core/pagination";

const mskDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.kafka(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("msk", "ListClustersV2", () =>
        client.send(new ListClustersV2Command({ NextToken: nextToken }))
      );

      for (const cluster of response.ClusterInfoList ?? []) {
        const clusterArn = cluster.ClusterArn!;
        const clusterName = cluster.ClusterName ?? clusterArn.split("/").slice(-2, -1)[0] ?? clusterArn;

        let enriched: Record<string, unknown> = cluster as Record<string, unknown>;

        try {
          const detail = await platform.scheduler.run("msk", "DescribeClusterV2", () =>
            client.send(new DescribeClusterV2Command({ ClusterArn: clusterArn }))
          );
          if (detail.ClusterInfo) {
            enriched = detail.ClusterInfo as Record<string, unknown>;
          }
        } catch {
          platform.logger.warn(`Could not describe MSK cluster ${clusterName}, using list data`);
        }

        const provisioned = enriched.Provisioned as Record<string, unknown> | undefined;
        const serverless = enriched.Serverless as Record<string, unknown> | undefined;
        const brokerInfo = provisioned?.BrokerNodeGroupInfo as Record<string, unknown> | undefined;

        const flatJson: Record<string, unknown> = {
          ...enriched,
          NumberOfBrokerNodes: provisioned?.NumberOfBrokerNodes ?? enriched.NumberOfBrokerNodes,
          BrokerInstanceType: brokerInfo?.InstanceType,
          KafkaVersion: (enriched.CurrentBrokerSoftwareInfo as Record<string, unknown> | undefined)?.KafkaVersion
            ?? (provisioned?.CurrentBrokerSoftwareInfo
              ? (provisioned.CurrentBrokerSoftwareInfo as Record<string, unknown>).KafkaVersion
              : undefined),
          ZookeeperConnectString: enriched.ZookeeperConnectString,
          ZookeeperConnectStringTls: enriched.ZookeeperConnectStringTls,
          BootstrapBrokerString: enriched.BootstrapBrokerString,
          BootstrapBrokerStringTls: enriched.BootstrapBrokerStringTls,
          IsServerless: serverless !== undefined,
          StoragePerBrokerGB: brokerInfo?.StorageInfo
            && (brokerInfo.StorageInfo as Record<string, unknown>).EbsStorageInfo
            && ((brokerInfo.StorageInfo as Record<string, unknown>).EbsStorageInfo as Record<string, unknown>).VolumeSize,
          SecurityGroups: brokerInfo?.SecurityGroups,
          ClientSubnets: brokerInfo?.ClientSubnets,
          EnhancedMonitoring: enriched.EnhancedMonitoring,
        };

        resources.push({
          arn: clusterArn,
          id: clusterName,
          type: ResourceTypes.mskCluster,
          service: "msk",
          accountId: scope.accountId,
          region: scope.region,
          name: clusterName,
          tags: {},
          rawJson: flatJson,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "msk:ListClustersV2",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerMskPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.mskCluster,
    service: "msk",
    serviceLabel: "MSK (Kafka)",
    displayName: "MSK Cluster",
    scope: "regional",
    ttlSeconds: 600,
    discoverer: mskDiscoverer,
    getTreeDescription: (resource) => {
      const version = resource.rawJson.KafkaVersion as string | undefined;
      const state = resource.rawJson.State as string | undefined;
      return version && state ? `Kafka ${version} (${state})` : state ?? version;
    },
  });
}
