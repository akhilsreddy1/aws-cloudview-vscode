import { GetInstanceProfileCommand } from "@aws-sdk/client-iam";
import type { RelationshipResolver, RelationshipResolution, ResolverContext, ResourceNode } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource, buildEc2Arn, buildIamRoleArn } from "../../core/resourceUtils";

const subnetResolver: RelationshipResolver = {
  id: "ec2-instance-subnet",
  sourceType: ResourceTypes.ec2Instance,
  relationshipType: "subnet",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const subnetId = source.rawJson.SubnetId as string | undefined;
    if (!subnetId) { return { nodes: [], edges: [] }; }

    const stubArn = buildEc2Arn(source.region, source.accountId, "subnet", subnetId);
    const stub = makeStubResource({
      arn: stubArn,
      id: subnetId,
      type: ResourceTypes.subnet,
      service: "vpc",
      accountId: source.accountId,
      region: source.region,
      name: subnetId,
    });

    return {
      nodes: [stub],
      edges: [{ fromArn: source.arn, toArn: stubArn, relationshipType: "subnet", metadataJson: {}, lastUpdated: Date.now() }],
    };
  },
};

const vpcResolver: RelationshipResolver = {
  id: "ec2-instance-vpc",
  sourceType: ResourceTypes.ec2Instance,
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

const securityGroupsResolver: RelationshipResolver = {
  id: "ec2-instance-security-groups",
  sourceType: ResourceTypes.ec2Instance,
  relationshipType: "security-groups",
  ttlSeconds: 300,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const securityGroups = source.rawJson.SecurityGroups as Array<{ GroupId?: string; GroupName?: string }> | undefined;
    if (!securityGroups?.length) { return { nodes: [], edges: [] }; }

    const nodes: ResourceNode[] = [];
    const edges = securityGroups.map((sg) => {
      const groupId = sg.GroupId!;
      const stubArn = buildEc2Arn(source.region, source.accountId, "security-group", groupId);
      nodes.push(makeStubResource({
        arn: stubArn,
        id: groupId,
        type: ResourceTypes.securityGroup,
        service: "vpc",
        accountId: source.accountId,
        region: source.region,
        name: sg.GroupName ?? groupId,
      }));
      return { fromArn: source.arn, toArn: stubArn, relationshipType: "security-groups", metadataJson: {}, lastUpdated: Date.now() };
    });

    return { nodes, edges };
  },
};

const iamRoleResolver: RelationshipResolver = {
  id: "ec2-instance-iam-role",
  sourceType: ResourceTypes.ec2Instance,
  relationshipType: "iam-role",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source, platform } = context;
    const profileArn = (source.rawJson.IamInstanceProfile as Record<string, unknown>)?.Arn as string | undefined;
    if (!profileArn) { return { nodes: [], edges: [] }; }

    const profileName = profileArn.split("/").pop()!;

    try {
      const iamClient = await platform.awsClientFactory.iam(source.accountId);
      const response = await platform.scheduler.run("iam", "GetInstanceProfile", () =>
        iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }))
      );

      const roles = response.InstanceProfile?.Roles ?? [];
      if (roles.length === 0) { return { nodes: [], edges: [] }; }

      const role = roles[0];
      const roleArn = role.Arn ?? buildIamRoleArn(source.accountId, role.RoleName!);
      const stub = makeStubResource({
        arn: roleArn,
        id: role.RoleName!,
        type: ResourceTypes.iamRole,
        service: "iam",
        accountId: source.accountId,
        region: "global",
        name: role.RoleName!,
      });

      return {
        nodes: [stub],
        edges: [{ fromArn: source.arn, toArn: roleArn, relationshipType: "iam-role", metadataJson: {}, lastUpdated: Date.now() }],
      };
    } catch {
      return { nodes: [], edges: [] };
    }
  },
};

const subnetVpcResolver: RelationshipResolver = {
  id: "subnet-vpc",
  sourceType: ResourceTypes.subnet,
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

const securityGroupVpcResolver: RelationshipResolver = {
  id: "security-group-vpc",
  sourceType: ResourceTypes.securityGroup,
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

export function registerEc2RelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(subnetResolver);
  registry.register(vpcResolver);
  registry.register(securityGroupsResolver);
  registry.register(iamRoleResolver);
  registry.register(subnetVpcResolver);
  registry.register(securityGroupVpcResolver);
}
