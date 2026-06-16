import {
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  type Bucket,
} from "@aws-sdk/client-s3";
import { GLOBAL_REGION } from "../../core/contracts";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildS3BucketArn, normalizeBucketLocation } from "../../core/resourceUtils";

/**
 * How many buckets to process concurrently. Each one issues up to 4 metadata
 * calls (location, encryption, versioning, public-access-block). Per-region
 * rate limits are still enforced by the platform scheduler — this cap just
 * controls how many buckets are in-flight from the orchestration layer.
 */
const BUCKET_CONCURRENCY = 8;

const s3BucketDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.s3(scope, "us-east-1");

    const listResponse = await platform.scheduler.run("s3", "ListBuckets", () =>
      client.send(new ListBucketsCommand({}))
    );

    const buckets = (listResponse.Buckets ?? []).filter((b): b is Bucket & { Name: string } => typeof b.Name === "string" && b.Name.length > 0);
    const resources: ResourceNode[] = [];

    /**
     * Fetch one bucket's full metadata. Location must come first (it picks
     * the regional client used for the remaining three calls), but encryption,
     * versioning, and public-access-block are independent and run in parallel.
     * Each call is wrapped in its own catch so a single permission denial on
     * one bucket doesn't break the whole refresh.
     */
    const processBucket = async (bucket: Bucket & { Name: string }): Promise<ResourceNode> => {
      const bucketName = bucket.Name;

      let bucketRegion = "us-east-1";
      try {
        const locationResponse = await platform.scheduler.run("s3", "GetBucketLocation", () =>
          client.send(new GetBucketLocationCommand({ Bucket: bucketName }))
        );
        bucketRegion = normalizeBucketLocation(locationResponse.LocationConstraint);
      } catch {
        // fall back to us-east-1
      }

      const regionClient = await platform.awsClientFactory.s3(scope, bucketRegion);

      const [encryptionType, versioningStatus, publicAccessBlocked] = await Promise.all([
        platform.scheduler.run("s3", "GetBucketEncryption", () =>
          regionClient.send(new GetBucketEncryptionCommand({ Bucket: bucketName }))
        ).then((enc) => {
          const rule = enc.ServerSideEncryptionConfiguration?.Rules?.[0];
          const algo = rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
          if (algo === "aws:kms" || algo === "aws:kms:dsse") return "SSE-KMS";
          if (algo === "AES256") return "SSE-S3";
          return algo ?? "None";
        }, () => "None"),
        platform.scheduler.run("s3", "GetBucketVersioning", () =>
          regionClient.send(new GetBucketVersioningCommand({ Bucket: bucketName }))
        ).then((ver) => ver.Status ?? "Disabled", () => "Disabled"),
        platform.scheduler.run("s3", "GetPublicAccessBlock", () =>
          regionClient.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }))
        ).then((pub) => {
          const cfg = pub.PublicAccessBlockConfiguration;
          return Boolean(
            cfg?.BlockPublicAcls && cfg?.BlockPublicPolicy &&
            cfg?.IgnorePublicAcls && cfg?.RestrictPublicBuckets
          );
        }, () => false),
      ]);

      return {
        arn: buildS3BucketArn(bucketName),
        id: bucketName,
        type: ResourceTypes.s3Bucket,
        service: "s3",
        accountId: scope.accountId,
        region: GLOBAL_REGION,
        name: bucketName,
        tags: {},
        rawJson: {
          ...(bucket as unknown as Record<string, unknown>),
          BucketRegion: bucketRegion,
          EncryptionType: encryptionType,
          IsEncrypted: encryptionType !== "None",
          VersioningStatus: versioningStatus,
          VersioningEnabled: versioningStatus === "Enabled",
          PublicAccessBlocked: publicAccessBlocked,
        },
        lastUpdated: Date.now(),
      };
    };

    // Process buckets in concurrent batches. Output order matches input order
    // (batches are sequential, but within a batch we await Promise.all).
    for (let i = 0; i < buckets.length; i += BUCKET_CONCURRENCY) {
      if (context.cancellation?.isCancellationRequested) break;
      const batch = buckets.slice(i, i + BUCKET_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(processBucket));
      for (const r of batchResults) resources.push(r);
    }

    return resources;
  },
};

export function registerS3BucketPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.s3Bucket,
    service: "s3",
    serviceLabel: "S3",
    displayName: "S3 Bucket",
    scope: "global",
    ttlSeconds: 600,
    discoverer: s3BucketDiscoverer,
    getTreeDescription: (resource) => {
      const region = resource.rawJson.BucketRegion as string | undefined;
      return region;
    },
  });
}
