import { ListQueuesCommand, GetQueueAttributesCommand, QueueAttributeName } from "@aws-sdk/client-sqs";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildSqsQueueArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Extracts the queue name (last path segment) from an SQS queue URL.
 * Queue URLs look like: `https://sqs.<region>.amazonaws.com/<acctId>/<name>`.
 */
function queueNameFromUrl(url: string): string {
  const idx = url.lastIndexOf("/");
  return idx >= 0 ? url.slice(idx + 1) : url;
}

/**
 * Parse a `DeadLetterTargetArn` out of a queue's RedrivePolicy attribute. The
 * attribute is stored as a JSON string by SQS, so callers get the ARN of the
 * DLQ this queue redrives to (or `undefined` if no DLQ is configured).
 */
function parseRedriveTargetArn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { deadLetterTargetArn?: string };
    return parsed?.deadLetterTargetArn;
  } catch {
    return undefined;
  }
}

const sqsQueueDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.sqs(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("sqs", "ListQueues", () =>
        client.send(new ListQueuesCommand({ NextToken: nextToken, MaxResults: 1000 }))
      );

      for (const queueUrl of response.QueueUrls ?? []) {
        const name = queueNameFromUrl(queueUrl);
        const arn = buildSqsQueueArn(scope.region, scope.accountId, name);

        // Fetch attributes so the dashboard can show message counts, FIFO
        // status, and the DLQ target. Best-effort: a permission error on one
        // queue must not break the whole discovery run.
        let attrs: Record<string, string> = {};
        try {
          const attrResp = await platform.scheduler.run("sqs", "GetQueueAttributes", () =>
            client.send(new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: [QueueAttributeName.All],
            }))
          );
          attrs = attrResp.Attributes ?? {};
        } catch {
          // fall through with empty attrs
        }

        const isFifo = name.endsWith(".fifo");
        const visibleMessages = Number(attrs["ApproximateNumberOfMessages"] ?? 0);
        const inFlightMessages = Number(attrs["ApproximateNumberOfMessagesNotVisible"] ?? 0);
        const delayedMessages = Number(attrs["ApproximateNumberOfMessagesDelayed"] ?? 0);
        const dlqTargetArn = parseRedriveTargetArn(attrs["RedrivePolicy"]);
        const isDlqSource = !!dlqTargetArn;
        // A queue is *itself* a DLQ when some other queue's RedrivePolicy
        // points at it. We can't know this from this queue's own attributes —
        // the resolver computes it post-hoc from discovered neighbours. Mark
        // the common naming convention here as a soft hint for the UI.
        const looksLikeDlq = /(?:^|[-_])(dlq|dead-?letter)(?:[-_.]|$)/i.test(name);

        resources.push({
          arn,
          id: name,
          type: ResourceTypes.sqsQueue,
          service: "sqs",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags: {},
          rawJson: {
            QueueUrl: queueUrl,
            QueueName: name,
            IsFifo: isFifo,
            VisibleMessages: visibleMessages,
            InFlightMessages: inFlightMessages,
            DelayedMessages: delayedMessages,
            TotalMessages: visibleMessages + inFlightMessages + delayedMessages,
            DlqTargetArn: dlqTargetArn,
            IsDlqSource: isDlqSource,
            LooksLikeDlq: looksLikeDlq,
            // Raw attributes preserved so the detail panel can surface
            // everything without re-querying.
            Attributes: attrs,
          },
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.NextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "sqs:ListQueues",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerSqsPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.sqsQueue,
    service: "sqs",
    serviceLabel: "SQS",
    displayName: "Queue",
    scope: "regional",
    ttlSeconds: 180,
    discoverer: sqsQueueDiscoverer,
    getTreeDescription: (resource) => {
      const visible = resource.rawJson.VisibleMessages as number | undefined;
      const fifo = resource.rawJson.IsFifo as boolean | undefined;
      const bits: string[] = [];
      if (fifo) bits.push("FIFO");
      if (typeof visible === "number") bits.push(`${visible} msg`);
      return bits.length > 0 ? bits.join(" \u00B7 ") : undefined;
    },
    detailFields: [
      { label: "Queue Name", path: "id", source: "resource" },
      { label: "ARN", path: "arn", source: "resource" },
      { label: "Visible messages", path: "VisibleMessages", source: "raw" },
      { label: "In-flight messages", path: "InFlightMessages", source: "raw" },
      { label: "Delayed messages", path: "DelayedMessages", source: "raw" },
      { label: "DLQ target ARN", path: "DlqTargetArn", source: "raw" },
    ],
    buildConsoleUrl: (resource) => {
      const name = encodeURIComponent(resource.id);
      return `https://${resource.region}.console.aws.amazon.com/sqs/v3/home?region=${resource.region}#/queues/https%3A%2F%2Fsqs.${resource.region}.amazonaws.com%2F${resource.accountId}%2F${name}`;
    },
  });
}
