import {
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { GLOBAL_REGION } from "../../core/contracts";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildS3BucketArn, normalizeBucketLocation } from "../../core/resourceUtils";

const s3BucketDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.s3(scope, "us-east-1");

    const listResponse = await platform.scheduler.run("s3", "ListBuckets", () =>
      client.send(new ListBucketsCommand({}))
    );

    const resources: ResourceNode[] = [];

    for (const bucket of listResponse.Buckets ?? []) {
      const bucketName = bucket.Name!;

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

      let encryptionType = "None";
      try {
        const enc = await platform.scheduler.run("s3", "GetBucketEncryption", () =>
          regionClient.send(new GetBucketEncryptionCommand({ Bucket: bucketName }))
        );
        const rule = enc.ServerSideEncryptionConfiguration?.Rules?.[0];
        const algo = rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
        if (algo === "aws:kms" || algo === "aws:kms:dsse") {
          encryptionType = "SSE-KMS";
        } else if (algo === "AES256") {
          encryptionType = "SSE-S3";
        } else if (algo) {
          encryptionType = algo;
        }
      } catch {
        encryptionType = "None";
      }

      let versioningStatus = "Disabled";
      try {
        const ver = await platform.scheduler.run("s3", "GetBucketVersioning", () =>
          regionClient.send(new GetBucketVersioningCommand({ Bucket: bucketName }))
        );
        versioningStatus = ver.Status ?? "Disabled";
      } catch {
        // default
      }

      let publicAccessBlocked = true;
      try {
        const pub = await platform.scheduler.run("s3", "GetPublicAccessBlock", () =>
          regionClient.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }))
        );
        const cfg = pub.PublicAccessBlockConfiguration;
        publicAccessBlocked = Boolean(
          cfg?.BlockPublicAcls && cfg?.BlockPublicPolicy &&
          cfg?.IgnorePublicAcls && cfg?.RestrictPublicBuckets
        );
      } catch {
        publicAccessBlocked = false;
      }

      resources.push({
        arn: buildS3BucketArn(bucketName),
        id: bucketName,
        type: ResourceTypes.s3Bucket,
        service: "s3",
        accountId: scope.accountId,
        region: GLOBAL_REGION,
        name: bucketName,
        tags: {},
        rawJson: {
          ...(bucket as Record<string, unknown>),
          BucketRegion: bucketRegion,
          EncryptionType: encryptionType,
          IsEncrypted: encryptionType !== "None",
          VersioningStatus: versioningStatus,
          VersioningEnabled: versioningStatus === "Enabled",
          PublicAccessBlocked: publicAccessBlocked,
        },
        lastUpdated: Date.now(),
      });
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
