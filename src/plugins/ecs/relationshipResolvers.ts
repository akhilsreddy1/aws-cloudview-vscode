import type { RelationshipResolver, RelationshipResolution, ResolverContext } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEcsClusterArn } from "../../core/resourceUtils";

const ecsServiceClusterResolver: RelationshipResolver = {
  id: "ecs-service-cluster",
  sourceType: ResourceTypes.ecsService,
  relationshipType: "ecs-cluster",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const clusterArn = source.rawJson.clusterArn as string | undefined;
    if (!clusterArn) { return { nodes: [], edges: [] }; }

    const clusterName = clusterArn.split("/").pop()!;
    const stub = makeStubResource({
      arn: clusterArn,
      id: clusterName,
      type: ResourceTypes.ecsCluster,
      service: "ecs",
      accountId: source.accountId,
      region: source.region,
      name: clusterName,
    });

    return {
      nodes: [stub],
      edges: [{ fromArn: source.arn, toArn: clusterArn, relationshipType: "ecs-cluster", metadataJson: {}, lastUpdated: Date.now() }],
    };
  },
};

export function registerEcsRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(ecsServiceClusterResolver);
}
