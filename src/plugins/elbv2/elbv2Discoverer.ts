import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeListenersCommand,
  DescribeTargetHealthCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

// ── Load Balancers (ALB / NLB / GLB) ────────────────────────────────────────

const albDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.elbv2(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("elbv2", "DescribeLoadBalancers", () =>
        client.send(new DescribeLoadBalancersCommand({ Marker: marker }))
      );

      for (const lb of response.LoadBalancers ?? []) {
        const lbArn = lb.LoadBalancerArn!;
        const lbName = lb.LoadBalancerName ?? lbArn.split("/").pop() ?? lbArn;

        // Fetch listeners for this load balancer
        const listeners: unknown[] = [];
        try {
          let listenerMarker: string | undefined;
          let listenerPages = 0;
          do {
            const listenerResp = await platform.scheduler.run("elbv2", "DescribeListeners", () =>
              client.send(new DescribeListenersCommand({ LoadBalancerArn: lbArn, Marker: listenerMarker }))
            );
            for (const l of listenerResp.Listeners ?? []) {
              listeners.push(l);
            }
            listenerMarker = listenerResp.NextMarker;
            listenerPages++;
            if (shouldStopPagination({
              pages: listenerPages, nextToken: listenerMarker, label: "elbv2:DescribeListeners",
              logger: platform.logger, cancellation: context.cancellation,
            })) break;
          } while (listenerMarker);
        } catch {
          // Listener fetch is best-effort; don't fail the LB discovery.
        }

        const listenerSummary = listeners.map((l: any) => `${l.Protocol ?? "?"}:${l.Port ?? "?"}`).join(", ");
        const azList = (lb.AvailabilityZones ?? []).map((az: any) => az.ZoneName).filter(Boolean);
        const sgList = lb.SecurityGroups ?? [];

        resources.push({
          arn: lbArn,
          id: lbName,
          type: ResourceTypes.alb,
          service: "ec2",
          accountId: scope.accountId,
          region: scope.region,
          name: lbName,
          tags: {},
          rawJson: {
            ...(lb as Record<string, unknown>),
            Listeners: listeners,
            ListenerCount: listeners.length,
            ListenerSummary: listenerSummary || "None",
            AvailabilityZoneList: azList.join(", "),
            AZCount: azList.length,
            SecurityGroupCount: sgList.length,
          },
          lastUpdated: Date.now(),
        });
      }

      marker = response.NextMarker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "elbv2:DescribeLoadBalancers",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── Target Groups ────────────────────────────────────────────────────────────

const targetGroupDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.elbv2(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("elbv2", "DescribeTargetGroups", () =>
        client.send(new DescribeTargetGroupsCommand({ Marker: marker }))
      );

      for (const tg of response.TargetGroups ?? []) {
        const tgArn = tg.TargetGroupArn!;
        const tgName = tg.TargetGroupName ?? tgArn.split("/").pop() ?? tgArn;

        // Fetch target health for this target group
        const targets: unknown[] = [];
        let healthyCount = 0;
        let unhealthyCount = 0;
        let drainingCount = 0;
        try {
          const healthResp = await platform.scheduler.run("elbv2", "DescribeTargetHealth", () =>
            client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }))
          );
          for (const thd of healthResp.TargetHealthDescriptions ?? []) {
            targets.push(thd);
            const state = thd.TargetHealth?.State?.toLowerCase() ?? "";
            if (state === "healthy") healthyCount++;
            else if (state === "unhealthy") unhealthyCount++;
            else if (state === "draining") drainingCount++;
          }
        } catch {
          // Target health fetch is best-effort; don't fail the TG discovery.
        }

        const lbArns = tg.LoadBalancerArns ?? [];
        const lbNames = lbArns.map((arn) => arn.split("/").slice(-2, -1)[0] || arn).join(", ");

        resources.push({
          arn: tgArn,
          id: tgName,
          type: ResourceTypes.targetGroup,
          service: "ec2",
          accountId: scope.accountId,
          region: scope.region,
          name: tgName,
          tags: {},
          rawJson: {
            ...(tg as Record<string, unknown>),
            Targets: targets,
            TargetCount: targets.length,
            HealthyCount: healthyCount,
            UnhealthyCount: unhealthyCount,
            DrainingCount: drainingCount,
            LoadBalancerCount: lbArns.length,
            LoadBalancerNames: lbNames || "None",
            HealthCheckSummary: tg.HealthCheckProtocol && tg.HealthCheckPath
              ? `${tg.HealthCheckProtocol}:${tg.HealthCheckPort ?? ""}${tg.HealthCheckPath}`
              : tg.HealthCheckProtocol ?? "None",
          },
          lastUpdated: Date.now(),
        });
      }

      marker = response.NextMarker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "elbv2:DescribeTargetGroups",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

export function registerAlbPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.alb,
    service: "ec2",
    serviceLabel: "EC2",
    displayName: "Load Balancer",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: albDiscoverer,
    getTreeDescription: (resource) => {
      const lbType = resource.rawJson.Type as string | undefined;
      const state = (resource.rawJson.State as Record<string, unknown> | undefined)?.Code as string | undefined;
      return lbType && state ? `${lbType} (${state})` : lbType ?? state;
    },
  });
}

export function registerTargetGroupPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.targetGroup,
    service: "ec2",
    serviceLabel: "EC2",
    displayName: "Target Group",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: targetGroupDiscoverer,
    getTreeDescription: (resource) => {
      const protocol = resource.rawJson.Protocol as string | undefined;
      const port = resource.rawJson.Port as number | undefined;
      return protocol && port ? `${protocol}:${port}` : protocol;
    },
  });
}
