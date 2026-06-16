import type { RelationshipResolver, RelationshipResolution, ResolverContext } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEc2Arn } from "../../core/resourceUtils";

const vpcResolver: RelationshipResolver = {
  id: "redshift-cluster-vpc",
  sourceType: ResourceTypes.redshiftCluster,
  relationshipType: "vpc",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const vpcId = source.rawJson.VpcId as string | undefined;
    if (!vpcId) { return { nodes: [], edges: [] }; }

    const stubArn = buildEc2Arn(source.region, source.accountId, "vpc", vpcId);
    const stub = makeStubResource({
      arn: stubArn,
      id: vpcId,
      type: ResourceTypes.vpc,
      service: "vpc",
      accountId: source.accountId,
      region: source.region,
      name: vpcId,
    });

    return {
      nodes: [stub],
      edges: [{ fromArn: source.arn, toArn: stubArn, relationshipType: "vpc", metadataJson: {}, lastUpdated: Date.now() }],
    };
  },
};

export function registerRedshiftRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(vpcResolver);
}
