import {
  ListStreamsCommand,
  DescribeStreamSummaryCommand,
  ListStreamConsumersCommand,
  ListTagsForStreamCommand,
} from "@aws-sdk/client-kinesis";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildKinesisStreamArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Kinesis Data Streams discoverer.
 *
 * For each stream we do one paginated `ListStreams` sweep, then per stream:
 *   1. `DescribeStreamSummary`  — mode, shard count, retention, encryption
 *   2. `ListStreamConsumers`    — enhanced fan-out consumer count (best-effort)
 *   3. `ListTagsForStream`      — tags
 *
 * ListStreamConsumers is best-effort — a permission failure on one stream must
 * not fail the whole discovery run (matches SQS + others).
 */
const kinesisStreamDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.kinesis(scope);
    const resources: ResourceNode[] = [];
    let exclusiveStartStreamName: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("kinesis", "ListStreams", () =>
        client.send(new ListStreamsCommand({
          Limit: 100,
          ExclusiveStartStreamName: exclusiveStartStreamName,
        })),
      );

      const streamNames = response.StreamNames ?? [];
      for (const streamName of streamNames) {
        const arn = buildKinesisStreamArn(scope.region, scope.accountId, streamName);

        // ── Describe stream summary (config) ─────────────────────────────
        let summary: Record<string, unknown> = {};
        try {
          const desc = await platform.scheduler.run("kinesis", "DescribeStreamSummary", () =>
            client.send(new DescribeStreamSummaryCommand({ StreamName: streamName })),
          );
          summary = (desc.StreamDescriptionSummary ?? {}) as Record<string, unknown>;
        } catch {
          // Fall through — keep the stream row with minimal data.
        }

        // ── Enhanced fan-out consumers count (best-effort) ───────────────
        let consumerCount = 0;
        try {
          let consumerToken: string | undefined;
          for (let i = 0; i < 5; i += 1) {
            const resp = await platform.scheduler.run("kinesis", "ListStreamConsumers", () =>
              client.send(new ListStreamConsumersCommand({
                StreamARN: arn,
                NextToken: consumerToken,
                MaxResults: 100,
              })),
            );
            consumerCount += (resp.Consumers ?? []).length;
            consumerToken = resp.NextToken;
            if (!consumerToken) break;
          }
        } catch {
          // Ignore — many callers don't have permission for this, and it's
          // a soft metric that doesn't affect the primary row.
        }

        // ── Tags (best-effort) ───────────────────────────────────────────
        const tags: Record<string, string> = {};
        try {
          const tagResp = await platform.scheduler.run("kinesis", "ListTagsForStream", () =>
            client.send(new ListTagsForStreamCommand({ StreamName: streamName })),
          );
          for (const t of tagResp.Tags ?? []) {
            if (t.Key) tags[t.Key] = t.Value ?? "";
          }
        } catch {
          // ignore
        }

        const streamMode = ((summary.StreamModeDetails as { StreamMode?: string } | undefined)?.StreamMode) ?? "PROVISIONED";
        const encryptionType = summary.EncryptionType as string | undefined;
        const kmsKeyId = summary.KeyId as string | undefined;
        const status = summary.StreamStatus as string | undefined;
        const openShardCount = (summary.OpenShardCount as number | undefined) ?? 0;
        const retentionPeriodHours = (summary.RetentionPeriodHours as number | undefined) ?? 24;
        const creationTs = summary.StreamCreationTimestamp as Date | undefined;

        resources.push({
          arn,
          id: streamName,
          type: ResourceTypes.kinesisStream,
          service: "kinesis",
          accountId: scope.accountId,
          region: scope.region,
          name: streamName,
          tags,
          rawJson: {
            StreamName: streamName,
            StreamStatus: status,
            StreamMode: streamMode,
            OpenShardCount: openShardCount,
            RetentionPeriodHours: retentionPeriodHours,
            EncryptionType: encryptionType,
            KeyId: kmsKeyId,
            IsEncrypted: encryptionType === "KMS",
            ConsumerCount: consumerCount,
            CreationTimestamp: creationTs ? creationTs.toISOString() : undefined,
            // Keep the raw summary as-is so the drawer can surface fields we
            // don't hoist to the primary row.
            Summary: summary,
          },
          lastUpdated: Date.now(),
        });
      }

      // `HasMoreStreams` is the pagination signal for ListStreams. The next
      // page starts after the last stream name in the current page.
      const hasMore = Boolean(response.HasMoreStreams);
      exclusiveStartStreamName = hasMore && streamNames.length > 0
        ? streamNames[streamNames.length - 1]
        : undefined;
      pages++;
      if (shouldStopPagination({
        pages,
        nextToken: exclusiveStartStreamName,
        label: "kinesis:ListStreams",
        logger: platform.logger,
        cancellation: context.cancellation,
      })) break;
    } while (exclusiveStartStreamName);

    return resources;
  },
};

export function registerKinesisPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.kinesisStream,
    service: "kinesis",
    serviceLabel: "Kinesis",
    displayName: "Data Stream",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: kinesisStreamDiscoverer,
    getTreeDescription: (resource) => {
      const shards = resource.rawJson.OpenShardCount as number | undefined;
      const mode = resource.rawJson.StreamMode as string | undefined;
      const bits: string[] = [];
      if (mode) bits.push(mode === "ON_DEMAND" ? "on-demand" : "provisioned");
      if (typeof shards === "number") bits.push(`${shards} shard${shards === 1 ? "" : "s"}`);
      return bits.length > 0 ? bits.join(" · ") : undefined;
    },
    detailFields: [
      { label: "Stream Name", path: "id", source: "resource" },
      { label: "ARN", path: "arn", source: "resource" },
      { label: "Status", path: "StreamStatus", source: "raw" },
      { label: "Mode", path: "StreamMode", source: "raw" },
      { label: "Open shards", path: "OpenShardCount", source: "raw" },
      { label: "Retention (hours)", path: "RetentionPeriodHours", source: "raw" },
      { label: "Encryption", path: "EncryptionType", source: "raw" },
      { label: "KMS Key", path: "KeyId", source: "raw" },
      { label: "Enhanced fan-out consumers", path: "ConsumerCount", source: "raw" },
      { label: "Created", path: "CreationTimestamp", source: "raw" },
    ],
    buildConsoleUrl: (resource) => {
      const name = encodeURIComponent(resource.id);
      return `https://${resource.region}.console.aws.amazon.com/kinesis/home?region=${resource.region}#/streams/details/${name}/details`;
    },
  });
}
