import {
  ListStateMachinesCommand,
  DescribeStateMachineCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-sfn";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Discovers AWS Step Functions state machines in a region.
 *
 * For each state machine returned by `ListStateMachines`, we issue a
 * `DescribeStateMachine` call to capture the IAM role, type (STANDARD vs.
 * EXPRESS), creation date, and logging/tracing configuration. Tags are
 * fetched with `ListTagsForResource` — if tag listing is denied we fall
 * back to an empty tag map instead of failing the whole discovery.
 */
const sfnDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.sfn(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("sfn", "ListStateMachines", () =>
        client.send(new ListStateMachinesCommand({ nextToken }))
      );

      for (const machine of response.stateMachines ?? []) {
        const arn = machine.stateMachineArn;
        const name = machine.name;
        if (!arn || !name) continue;

        let enriched: Record<string, unknown> = machine as unknown as Record<string, unknown>;
        let tags: Record<string, string> = {};

        try {
          const detail = await platform.scheduler.run("sfn", "DescribeStateMachine", () =>
            client.send(new DescribeStateMachineCommand({ stateMachineArn: arn }))
          );
          enriched = {
            ...(machine as unknown as Record<string, unknown>),
            ...(detail as unknown as Record<string, unknown>),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          platform.logger.warn(`Could not describe state machine ${name}: ${message}`);
        }

        try {
          const tagResponse = await platform.scheduler.run("sfn", "ListTagsForResource", () =>
            client.send(new ListTagsForResourceCommand({ resourceArn: arn }))
          );
          tags = toTagMap(tagResponse.tags);
        } catch {
          // Tag listing may be denied — not fatal.
        }

        const creation = enriched.creationDate instanceof Date
          ? (enriched.creationDate as Date).toISOString()
          : (enriched.creationDate as string | undefined);

        const definition = typeof enriched.definition === "string" ? enriched.definition : undefined;
        let stateCount: number | undefined;
        if (definition) {
          try {
            const parsed = JSON.parse(definition) as { States?: Record<string, unknown> };
            if (parsed.States && typeof parsed.States === "object") {
              stateCount = Object.keys(parsed.States).length;
            }
          } catch {
            // Ignore malformed/non-JSON definitions (rare).
          }
        }

        const flat: Record<string, unknown> = {
          ...enriched,
          Name: name,
          StateMachineType: enriched.type ?? "STANDARD",
          Status: enriched.status ?? "ACTIVE",
          RoleArn: enriched.roleArn,
          CreationDate: creation,
          StateCount: stateCount,
          LoggingEnabled: (enriched.loggingConfiguration as { level?: string } | undefined)?.level !== undefined
            && (enriched.loggingConfiguration as { level?: string } | undefined)?.level !== "OFF",
          TracingEnabled: (enriched.tracingConfiguration as { enabled?: boolean } | undefined)?.enabled === true,
        };

        resources.push({
          arn,
          id: name,
          type: ResourceTypes.sfnStateMachine,
          service: "stepfunctions",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: flat,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.nextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "sfn:ListStateMachines",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerSfnPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.sfnStateMachine,
    service: "stepfunctions",
    serviceLabel: "Step Functions",
    displayName: "State Machine",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: sfnDiscoverer,
    getTreeDescription: (resource) => {
      const type = resource.rawJson.StateMachineType as string | undefined;
      const status = resource.rawJson.Status as string | undefined;
      return type && status ? `${type} (${status})` : (type ?? status);
    },
  });
}
