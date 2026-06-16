import {
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
  DescribeDBSnapshotsCommand,
  DescribeDBClusterSnapshotsCommand,
} from "@aws-sdk/client-rds";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, buildRdsArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

// ── DB Instances ─────────────────────────────────────────────────────────────

const rdsInstanceDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.rds(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("rds", "DescribeDBInstances", () =>
        client.send(new DescribeDBInstancesCommand({ Marker: marker }))
      );

      for (const instance of response.DBInstances ?? []) {
        const instanceId = instance.DBInstanceIdentifier!;
        const instanceArn = instance.DBInstanceArn ?? buildRdsArn(scope.region, scope.accountId, "db", instanceId);

        const pending = instance.PendingModifiedValues ?? {};
        const hasPendingMaintenance = Object.keys(pending).length > 0;
        const caCert = instance.CACertificateIdentifier ?? "";
        const isOldCaCert = caCert.includes("rds-ca-2019");

        const enriched: Record<string, unknown> = {
          ...(instance as Record<string, unknown>),
          PubliclyAccessible: instance.PubliclyAccessible ?? false,
          HasPendingMaintenance: hasPendingMaintenance,
          CACertificateIdentifier: caCert,
          IsOldCACert: isOldCaCert,
        };

        resources.push({
          arn: instanceArn,
          id: instanceId,
          type: ResourceTypes.rdsInstance,
          service: "rds",
          accountId: scope.accountId,
          region: scope.region,
          name: instanceId,
          tags: toTagMap(undefined),
          rawJson: enriched,
          lastUpdated: Date.now(),
        });
      }

      marker = response.Marker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "rds:DescribeDBInstances",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── DB Clusters (Aurora) ─────────────────────────────────────────────────────

const rdsClusterDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.rds(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("rds", "DescribeDBClusters", () =>
        client.send(new DescribeDBClustersCommand({ Marker: marker }))
      );

      for (const cluster of response.DBClusters ?? []) {
        const clusterId = cluster.DBClusterIdentifier!;
        const clusterArn = cluster.DBClusterArn ?? buildRdsArn(scope.region, scope.accountId, "cluster", clusterId);

        resources.push({
          arn: clusterArn,
          id: clusterId,
          type: ResourceTypes.rdsCluster,
          service: "rds",
          accountId: scope.accountId,
          region: scope.region,
          name: clusterId,
          tags: toTagMap(undefined),
          rawJson: cluster as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      marker = response.Marker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "rds:DescribeDBClusters",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── DB Snapshots (manual + automated) ────────────────────────────────────────

const rdsSnapshotDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.rds(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("rds", "DescribeDBSnapshots", () =>
        client.send(new DescribeDBSnapshotsCommand({ Marker: marker }))
      );

      for (const snapshot of response.DBSnapshots ?? []) {
        const snapshotId = snapshot.DBSnapshotIdentifier!;
        const snapshotArn = snapshot.DBSnapshotArn ?? buildRdsArn(scope.region, scope.accountId, "snapshot", snapshotId);

        resources.push({
          arn: snapshotArn,
          id: snapshotId,
          type: ResourceTypes.rdsSnapshot,
          service: "rds",
          accountId: scope.accountId,
          region: scope.region,
          name: snapshotId,
          tags: toTagMap(undefined),
          rawJson: snapshot as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      marker = response.Marker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "rds:DescribeDBSnapshots",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── DB Cluster Snapshots ─────────────────────────────────────────────────────

const rdsClusterSnapshotDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.rds(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("rds", "DescribeDBClusterSnapshots", () =>
        client.send(new DescribeDBClusterSnapshotsCommand({ Marker: marker }))
      );

      for (const snapshot of response.DBClusterSnapshots ?? []) {
        const snapshotId = snapshot.DBClusterSnapshotIdentifier!;
        const snapshotArn = snapshot.DBClusterSnapshotArn ?? buildRdsArn(scope.region, scope.accountId, "cluster-snapshot", snapshotId);

        resources.push({
          arn: snapshotArn,
          id: snapshotId,
          type: ResourceTypes.rdsClusterSnapshot,
          service: "rds",
          accountId: scope.accountId,
          region: scope.region,
          name: snapshotId,
          tags: toTagMap(undefined),
          rawJson: snapshot as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      marker = response.Marker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "rds:DescribeDBClusterSnapshots",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerRdsInstancePlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.rdsInstance,
    service: "rds",
    serviceLabel: "Databases",
    displayName: "DB Instance",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: rdsInstanceDiscoverer,
    getTreeDescription: (resource) => {
      const engine = resource.rawJson.Engine as string | undefined;
      const instanceClass = resource.rawJson.DBInstanceClass as string | undefined;
      return engine && instanceClass ? `${engine} ${instanceClass}` : engine ?? instanceClass;
    },
  });
}

export function registerRdsClusterPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.rdsCluster,
    service: "rds",
    serviceLabel: "Databases",
    displayName: "DB Cluster",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: rdsClusterDiscoverer,
    getTreeDescription: (resource) => {
      const engine = resource.rawJson.Engine as string | undefined;
      const status = resource.rawJson.Status as string | undefined;
      return engine && status ? `${engine} (${status})` : engine ?? status;
    },
  });
}

export function registerRdsSnapshotPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.rdsSnapshot,
    service: "rds",
    serviceLabel: "Databases",
    displayName: "DB Snapshot",
    scope: "regional",
    ttlSeconds: 600,
    discoverer: rdsSnapshotDiscoverer,
    getTreeDescription: (resource) => {
      const snapshotType = resource.rawJson.SnapshotType as string | undefined;
      const engine = resource.rawJson.Engine as string | undefined;
      return snapshotType && engine ? `${snapshotType} (${engine})` : snapshotType ?? engine;
    },
  });
}

export function registerRdsClusterSnapshotPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.rdsClusterSnapshot,
    service: "rds",
    serviceLabel: "Databases",
    displayName: "Cluster Snapshot",
    scope: "regional",
    ttlSeconds: 600,
    discoverer: rdsClusterSnapshotDiscoverer,
    getTreeDescription: (resource) => {
      const snapshotType = resource.rawJson.SnapshotType as string | undefined;
      const engine = resource.rawJson.Engine as string | undefined;
      return snapshotType && engine ? `${snapshotType} (${engine})` : snapshotType ?? engine;
    },
  });
}
