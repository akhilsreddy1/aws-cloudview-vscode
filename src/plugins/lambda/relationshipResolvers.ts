import type { RelationshipResolver, RelationshipResolution, ResolverContext, ResourceNode } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEc2Arn, buildIamRoleArn } from "../../core/resourceUtils";

const vpcResolver: RelationshipResolver = {
  id: "lambda-vpc",
  sourceType: ResourceTypes.lambdaFunction,
  relationshipType: "vpc",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const vpcConfig = source.rawJson.VpcConfig as Record<string, unknown> | undefined;
    const vpcId = vpcConfig?.VpcId as string | undefined;
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

const subnetsResolver: RelationshipResolver = {
  id: "lambda-subnets",
  sourceType: ResourceTypes.lambdaFunction,
  relationshipType: "subnets",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const vpcConfig = source.rawJson.VpcConfig as Record<string, unknown> | undefined;
    const subnetIds = vpcConfig?.SubnetIds as string[] | undefined;
    if (!subnetIds?.length) { return { nodes: [], edges: [] }; }

    const nodes: ResourceNode[] = [];
    const edges = subnetIds.map((subnetId) => {
      const stubArn = buildEc2Arn(source.region, source.accountId, "subnet", subnetId);
      nodes.push(makeStubResource({
        arn: stubArn,
        id: subnetId,
        type: ResourceTypes.subnet,
        service: "vpc",
        accountId: source.accountId,
        region: source.region,
        name: subnetId,
      }));
      return { fromArn: source.arn, toArn: stubArn, relationshipType: "subnets", metadataJson: {}, lastUpdated: Date.now() };
    });

    return { nodes, edges };
  },
};

const roleResolver: RelationshipResolver = {
  id: "lambda-iam-role",
  sourceType: ResourceTypes.lambdaFunction,
  relationshipType: "iam-role",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const roleArn = source.rawJson.Role as string | undefined;
    if (!roleArn) { return { nodes: [], edges: [] }; }

    const roleName = roleArn.split("/").pop()!;
    const stub = makeStubResource({
      arn: roleArn,
      id: roleName,
      type: ResourceTypes.iamRole,
      service: "iam",
      accountId: source.accountId,
      region: "global",
      name: roleName,
    });

    return {
      nodes: [stub],
      edges: [{ fromArn: source.arn, toArn: roleArn, relationshipType: "iam-role", metadataJson: {}, lastUpdated: Date.now() }],
    };
  },
};

export function registerLambdaRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(vpcResolver);
  registry.register(subnetsResolver);
  registry.register(roleResolver);
}
