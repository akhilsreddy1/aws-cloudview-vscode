import { ListEventBusesCommand, ListRulesCommand } from "@aws-sdk/client-eventbridge";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildEventBridgeArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const eventBridgeBusDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.eventbridge(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("eventbridge", "ListEventBuses", () =>
        client.send(new ListEventBusesCommand({ NextToken: nextToken }))
      );

      for (const bus of response.EventBuses ?? []) {
        const busName = bus.Name!;
        const busArn = bus.Arn ?? buildEventBridgeArn(scope.region, scope.accountId, "event-bus", busName);

        resources.push({
          arn: busArn,
          id: busName,
          type: ResourceTypes.eventBridgeBus,
          service: "eventbridge",
          accountId: scope.accountId,
          region: scope.region,
          name: busName,
          tags: {},
          rawJson: bus as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "eventbridge:ListEventBuses",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

const eventBridgeRuleDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.eventbridge(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("eventbridge", "ListRules", () =>
        client.send(new ListRulesCommand({ NextToken: nextToken }))
      );

      for (const rule of response.Rules ?? []) {
        const ruleName = rule.Name!;
        const ruleArn = rule.Arn ?? buildEventBridgeArn(scope.region, scope.accountId, "rule", ruleName);

        resources.push({
          arn: ruleArn,
          id: ruleName,
          type: ResourceTypes.eventBridgeRule,
          service: "eventbridge",
          accountId: scope.accountId,
          region: scope.region,
          name: ruleName,
          tags: {},
          rawJson: rule as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "eventbridge:ListRules",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerEventBridgeBusPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.eventBridgeBus,
    service: "eventbridge",
    serviceLabel: "EventBridge",
    displayName: "Event Bus",
    scope: "regional",
    ttlSeconds: 600,
    discoverer: eventBridgeBusDiscoverer,
    detailFields: [
      { label: "Bus Name", path: "id", source: "resource" },
      { label: "ARN", path: "arn", source: "resource" },
    ],
  });
}

export function registerEventBridgeRulePlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.eventBridgeRule,
    service: "eventbridge",
    serviceLabel: "EventBridge",
    displayName: "EventBridge Rule",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: eventBridgeRuleDiscoverer,
    detailFields: [
      { label: "Rule Name", path: "id", source: "resource" },
      { label: "State", path: "State", source: "raw" },
      { label: "Bus Name", path: "EventBusName", source: "raw" },
      { label: "Schedule Expression", path: "ScheduleExpression", source: "raw" },
    ],
  });
}
