import type { RelationshipResolver, RelationshipResolution, ResolverContext } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEventBridgeArn } from "../../core/resourceUtils";

const busResolver: RelationshipResolver = {
  id: "eventbridge-rule-bus",
  sourceType: ResourceTypes.eventBridgeRule,
  relationshipType: "event-bus",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const busName = source.rawJson.EventBusName as string | undefined;
    if (!busName) { return { nodes: [], edges: [] }; }

    const busArn = buildEventBridgeArn(source.region, source.accountId, "event-bus", busName);
    const stub = makeStubResource({
      arn: busArn,
      id: busName,
      type: ResourceTypes.eventBridgeBus,
      service: "eventbridge",
      accountId: source.accountId,
      region: source.region,
      name: busName,
    });

    return {
      nodes: [stub],
      edges: [{ fromArn: source.arn, toArn: busArn, relationshipType: "event-bus", metadataJson: {}, lastUpdated: Date.now() }],
    };
  },
};

export function registerEventBridgeRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(busResolver);
}
