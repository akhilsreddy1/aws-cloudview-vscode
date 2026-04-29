import { GetBucketEncryptionCommand } from "@aws-sdk/client-s3";
import type { RelationshipResolver, RelationshipResolution, ResolverContext } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource } from "../../core/resourceUtils";

const kmsResolver: RelationshipResolver = {
  id: "s3-bucket-kms-key",
  sourceType: ResourceTypes.s3Bucket,
  relationshipType: "kms-key",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source, platform } = context;
    const bucketRegion = (source.rawJson.BucketRegion as string) ?? "us-east-1";

    try {
      const client = await platform.awsClientFactory.s3(
        { profileName: source.accountId, accountId: source.accountId, region: bucketRegion },
        bucketRegion
      );

      const response = await platform.scheduler.run("s3", "GetBucketEncryption", () =>
        client.send(new GetBucketEncryptionCommand({ Bucket: source.id }))
      );

      const rules = response.ServerSideEncryptionConfiguration?.Rules ?? [];
      for (const rule of rules) {
        const kmsKeyId = rule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
        if (kmsKeyId) {
          const kmsArn = kmsKeyId.startsWith("arn:") ? kmsKeyId : `arn:aws:kms:${bucketRegion}:${source.accountId}:key/${kmsKeyId}`;
          const stub = makeStubResource({
            arn: kmsArn,
            id: kmsKeyId,
            type: ResourceTypes.kmsKey,
            service: "kms",
            accountId: source.accountId,
            region: bucketRegion,
            name: kmsKeyId,
          });

          return {
            nodes: [stub],
            edges: [{ fromArn: source.arn, toArn: kmsArn, relationshipType: "kms-key", metadataJson: {}, lastUpdated: Date.now() }],
          };
        }
      }
    } catch {
      // bucket may not have encryption config
    }

    return { nodes: [], edges: [] };
  },
};

export function registerS3RelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(kmsResolver);
}
