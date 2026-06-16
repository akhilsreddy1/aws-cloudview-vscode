import type { RelationshipResolver, RelationshipResolution, ResolverContext, ResourceNode } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEc2Arn } from "../../core/resourceUtils";

const vpcResolver: RelationshipResolver = {
  id: "rds-instance-vpc",
  sourceType: ResourceTypes.rdsInstance,
  relationshipType: "vpc",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const dbSubnetGroup = source.rawJson.DBSubnetGroup as Record<string, unknown> | undefined;
    const vpcId = dbSubnetGroup?.VpcId as string | undefined;
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

const securityGroupsResolver: RelationshipResolver = {
  id: "rds-instance-security-groups",
  sourceType: ResourceTypes.rdsInstance,
  relationshipType: "security-groups",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const vpcSecurityGroups = source.rawJson.VpcSecurityGroups as Array<{ VpcSecurityGroupId?: string; Status?: string }> | undefined;
    if (!vpcSecurityGroups?.length) { return { nodes: [], edges: [] }; }

    const nodes: ResourceNode[] = [];
    const edges = vpcSecurityGroups.map((sg) => {
      const groupId = sg.VpcSecurityGroupId!;
      const stubArn = buildEc2Arn(source.region, source.accountId, "security-group", groupId);
      nodes.push(makeStubResource({
        arn: stubArn,
        id: groupId,
        type: ResourceTypes.securityGroup,
        service: "vpc",
        accountId: source.accountId,
        region: source.region,
        name: groupId,
      }));
      return { fromArn: source.arn, toArn: stubArn, relationshipType: "security-groups", metadataJson: {}, lastUpdated: Date.now() };
    });

    return { nodes, edges };
  },
};

export function registerRdsRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(vpcResolver);
  registry.register(securityGroupsResolver);
}
