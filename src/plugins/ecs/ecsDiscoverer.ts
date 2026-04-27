import {
  ListClustersCommand,
  DescribeClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

// ── Clusters ─────────────────────────────────────────────────────────────────

const ecsClusterDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ecs(scope);
    const clusterArns: string[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ecs", "ListClusters", () =>
        client.send(new ListClustersCommand({ nextToken }))
      );
      clusterArns.push(...(response.clusterArns ?? []));
      nextToken = response.nextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ecs:ListClusters",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    if (clusterArns.length === 0) { return []; }

    const describeResponse = await platform.scheduler.run("ecs", "DescribeClusters", () =>
      client.send(new DescribeClustersCommand({ clusters: clusterArns }))
    );

    const resources: ResourceNode[] = [];
    for (const cluster of describeResponse.clusters ?? []) {
      const clusterName = cluster.clusterName!;
      const tags = toTagMap(cluster.tags);
      const name = extractNameTag(tags) ?? clusterName;

      resources.push({
        arn: cluster.clusterArn!,
        id: clusterName,
        type: ResourceTypes.ecsCluster,
        service: "ecs",
        accountId: scope.accountId,
        region: scope.region,
        name,
        tags,
        rawJson: cluster as Record<string, unknown>,
        lastUpdated: Date.now(),
      });
    }

    return resources;
  },
};

// ── Services ─────────────────────────────────────────────────────────────────

const ecsServiceDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ecs(scope);

    const clusterArns: string[] = [];
    let clusterToken: string | undefined;
    let clusterPages = 0;
    do {
      const response = await platform.scheduler.run("ecs", "ListClusters", () =>
        client.send(new ListClustersCommand({ nextToken: clusterToken }))
      );
      clusterArns.push(...(response.clusterArns ?? []));
      clusterToken = response.nextToken;
      clusterPages++;
      if (shouldStopPagination({
        pages: clusterPages, nextToken: clusterToken, label: "ecs:ListClusters",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (clusterToken);

    const resources: ResourceNode[] = [];

    for (const clusterArn of clusterArns) {
      const serviceArns: string[] = [];
      let serviceToken: string | undefined;
      let servicePages = 0;

      do {
        const response = await platform.scheduler.run("ecs", "ListServices", () =>
          client.send(new ListServicesCommand({ cluster: clusterArn, nextToken: serviceToken }))
        );
        serviceArns.push(...(response.serviceArns ?? []));
        serviceToken = response.nextToken;
        servicePages++;
        if (shouldStopPagination({
          pages: servicePages, nextToken: serviceToken, label: "ecs:ListServices",
          logger: platform.logger, cancellation: context.cancellation,
        })) break;
      } while (serviceToken);

      if (serviceArns.length === 0) { continue; }

      // DescribeServices allows at most 10 service names per request.
      const describeBatchSize = 10;
      for (let s = 0; s < serviceArns.length; s += describeBatchSize) {
        const batch = serviceArns.slice(s, s + describeBatchSize);
        const describeResponse = await platform.scheduler.run("ecs", "DescribeServices", () =>
          client.send(new DescribeServicesCommand({ cluster: clusterArn, services: batch }))
        );

        for (const service of describeResponse.services ?? []) {
          const serviceName = service.serviceName!;
          const tags = toTagMap(service.tags);
          const name = extractNameTag(tags) ?? serviceName;

          resources.push({
            arn: service.serviceArn!,
            id: serviceName,
            type: ResourceTypes.ecsService,
            service: "ecs",
            accountId: scope.accountId,
            region: scope.region,
            name,
            tags,
            rawJson: service as Record<string, unknown>,
            lastUpdated: Date.now(),
          });
        }
      }
    }

    return resources;
  },
};

// ── Tasks (with container detail) ────────────────────────────────────────────

const ecsTaskDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ecs(scope);

    const clusterArns: string[] = [];
    let clusterToken: string | undefined;
    let clusterPages = 0;
    do {
      const response = await platform.scheduler.run("ecs", "ListClusters", () =>
        client.send(new ListClustersCommand({ nextToken: clusterToken }))
      );
      clusterArns.push(...(response.clusterArns ?? []));
      clusterToken = response.nextToken;
      clusterPages++;
      if (shouldStopPagination({
        pages: clusterPages, nextToken: clusterToken, label: "ecs:ListClusters",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (clusterToken);

    const resources: ResourceNode[] = [];

    for (const clusterArn of clusterArns) {
      const clusterName = clusterArn.split("/").pop() ?? clusterArn;
      const taskArns: string[] = [];
      let taskToken: string | undefined;
      let taskPages = 0;

      do {
        const response = await platform.scheduler.run("ecs", "ListTasks", () =>
          client.send(new ListTasksCommand({ cluster: clusterArn, nextToken: taskToken }))
        );
        taskArns.push(...(response.taskArns ?? []));
        taskToken = response.nextToken;
        taskPages++;
        if (shouldStopPagination({
          pages: taskPages, nextToken: taskToken, label: "ecs:ListTasks",
          logger: platform.logger, cancellation: context.cancellation,
        })) break;
      } while (taskToken);

      if (taskArns.length === 0) { continue; }

      const batchSize = 100;
      for (let i = 0; i < taskArns.length; i += batchSize) {
        const batch = taskArns.slice(i, i + batchSize);
        const describeResponse = await platform.scheduler.run("ecs", "DescribeTasks", () =>
          client.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: batch }))
        );

        for (const task of describeResponse.tasks ?? []) {
          const taskArn = task.taskArn!;
          const taskId = taskArn.split("/").pop() ?? taskArn;
          const containers = task.containers ?? [];
          const taskDefArn = task.taskDefinitionArn ?? "";
          const taskDefShort = taskDefArn.split("/").pop() ?? taskDefArn;

          const containerSummaries = containers.map((c) => ({
            name: c.name,
            image: c.image,
            lastStatus: c.lastStatus,
            healthStatus: c.healthStatus,
            cpu: c.cpu,
            memory: c.memory,
            memoryReservation: c.memoryReservation,
            networkBindings: c.networkBindings,
            networkInterfaces: c.networkInterfaces,
            exitCode: c.exitCode,
            reason: c.reason,
          }));

          const primaryContainer = containers[0];
          const healthStatuses = containers.map((c) => c.healthStatus).filter(Boolean);
          const allHealthy = healthStatuses.length > 0 && healthStatuses.every((s) => s === "HEALTHY");
          const anyUnhealthy = healthStatuses.some((s) => s === "UNHEALTHY");

          const flat: Record<string, unknown> = {
            ...(task as Record<string, unknown>),
            ClusterName: clusterName,
            TaskDefinitionShort: taskDefShort,
            ContainerCount: containers.length,
            ContainerName: primaryContainer?.name,
            ContainerImage: primaryContainer?.image,
            ContainerStatus: primaryContainer?.lastStatus,
            HealthStatus: anyUnhealthy ? "UNHEALTHY" : allHealthy ? "HEALTHY" : "UNKNOWN",
            Cpu: task.cpu,
            Memory: task.memory,
            LaunchType: task.launchType,
            PlatformVersion: task.platformVersion,
            Connectivity: task.connectivity,
            ContainersSummary: containerSummaries,
          };

          resources.push({
            arn: taskArn,
            id: taskId,
            type: ResourceTypes.ecsTask,
            service: "ecs",
            accountId: scope.accountId,
            region: scope.region,
            name: `${primaryContainer?.name ?? taskId} (${taskDefShort})`,
            tags: toTagMap(task.tags),
            rawJson: flat,
            lastUpdated: Date.now(),
          });
        }
      }
    }

    return resources;
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerEcsClusterPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.ecsCluster,
    service: "ecs",
    serviceLabel: "ECS",
    displayName: "ECS Cluster",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: ecsClusterDiscoverer,
  });
}

export function registerEcsServicePlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.ecsService,
    service: "ecs",
    serviceLabel: "ECS",
    displayName: "ECS Service",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: ecsServiceDiscoverer,
    getTreeDescription: (resource) => {
      const desired = resource.rawJson.desiredCount as number | undefined;
      const running = resource.rawJson.runningCount as number | undefined;
      return desired !== undefined ? `${running ?? 0}/${desired} tasks` : undefined;
    },
  });
}

export function registerEcsTaskPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.ecsTask,
    service: "ecs",
    serviceLabel: "ECS",
    displayName: "ECS Task",
    scope: "regional",
    ttlSeconds: 120,
    discoverer: ecsTaskDiscoverer,
    getTreeDescription: (resource) => {
      const status = resource.rawJson.ContainerStatus as string | undefined;
      const image = resource.rawJson.ContainerImage as string | undefined;
      const shortImage = image?.split("/").pop()?.split(":")[0];
      return shortImage && status ? `${shortImage} (${status})` : status;
    },
  });
}
