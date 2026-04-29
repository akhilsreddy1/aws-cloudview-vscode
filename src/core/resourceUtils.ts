import { GLOBAL_REGION, type JsonRecord, type ResourceNode, type TagMap } from "./contracts";
import { ResourceTypes } from "./resourceTypes";

export interface StubResourceInput {
  arn: string;
  id: string;
  type: string;
  service: string;
  accountId: string;
  region: string;
  name: string;
  rawJson?: JsonRecord;
}

export function toTagMap(
  tags:
    | Array<{ Key?: string | null; Value?: string | null }>
    | Array<{ key?: string | null; value?: string | null }>
    | undefined
): TagMap {
  const result: TagMap = {};

  for (const tag of tags ?? []) {
    const record = tag as { Key?: string | null; Value?: string | null; key?: string | null; value?: string | null };
    const key = record.Key ?? record.key;
    const value = record.Value ?? record.value;
    if (key && value !== undefined && value !== null) {
      result[key] = value;
    }
  }

  return result;
}

export function extractNameTag(tags: TagMap): string | undefined {
  return tags.Name ?? tags.name;
}

export function buildEc2Arn(region: string, accountId: string, resourceType: string, id: string): string {
  return `arn:aws:ec2:${region}:${accountId}:${resourceType}/${id}`;
}

/** VPC Lattice ARNs use `servicenetwork` or `service` segments (see API responses). */
export function buildVpcLatticeArn(
  region: string,
  accountId: string,
  segment: "servicenetwork" | "service",
  id: string
): string {
  return `arn:aws:vpc-lattice:${region}:${accountId}:${segment}/${id}`;
}

export function buildS3BucketArn(bucketName: string): string {
  return `arn:aws:s3:::${bucketName}`;
}

export function buildIamRoleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

export function buildLambdaArn(region: string, accountId: string, functionName: string): string {
  return `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
}

export function buildEcsClusterArn(region: string, accountId: string, clusterName: string): string {
  return `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`;
}

export function buildEcsServiceArn(region: string, accountId: string, clusterName: string, serviceName: string): string {
  return `arn:aws:ecs:${region}:${accountId}:service/${clusterName}/${serviceName}`;
}

export function buildRdsArn(region: string, accountId: string, resourceType: string, id: string): string {
  return `arn:aws:rds:${region}:${accountId}:${resourceType}:${id}`;
}

export function buildDynamodbTableArn(region: string, accountId: string, tableName: string): string {
  return `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
}

export function buildRedshiftArn(region: string, accountId: string, clusterId: string): string {
  return `arn:aws:redshift:${region}:${accountId}:cluster:${clusterId}`;
}

export function buildEventBridgeArn(region: string, accountId: string, resourceType: string, name: string): string {
  return `arn:aws:events:${region}:${accountId}:${resourceType}/${name}`;
}

export function buildMskClusterArn(region: string, accountId: string, clusterName: string, clusterId: string): string {
  return `arn:aws:kafka:${region}:${accountId}:cluster/${clusterName}/${clusterId}`;
}

export function buildSqsQueueArn(region: string, accountId: string, queueName: string): string {
  return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
}

/**
 * SQS `GetQueueAttributes` / send/receive calls expect the queue URL, not the
 * ARN. Derive it from the well-known pattern used everywhere in AWS commercial
 * partitions: `https://sqs.<region>.amazonaws.com/<accountId>/<queueName>`.
 */
export function buildSqsQueueUrl(region: string, accountId: string, queueName: string): string {
  return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}

export function buildEcrRepositoryArn(region: string, accountId: string, repoName: string): string {
  return `arn:aws:ecr:${region}:${accountId}:repository/${repoName}`;
}

export function buildCfnStackArn(region: string, accountId: string, stackName: string, stackId: string): string {
  return `arn:aws:cloudformation:${region}:${accountId}:stack/${stackName}/${stackId}`;
}

export function buildSfnStateMachineArn(region: string, accountId: string, name: string): string {
  return `arn:aws:states:${region}:${accountId}:stateMachine:${name}`;
}

export function buildSfnExecutionArn(region: string, accountId: string, stateMachineName: string, executionName: string): string {
  return `arn:aws:states:${region}:${accountId}:execution:${stateMachineName}:${executionName}`;
}

export function buildLogGroupArn(region: string, accountId: string, logGroupName: string): string {
  return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}:*`;
}

export function normalizeBucketLocation(location?: string | null): string {
  if (!location || location === "EU") {
    return location === "EU" ? "eu-west-1" : "us-east-1";
  }

  return location;
}

export function makeStubResource(input: StubResourceInput): ResourceNode {
  return {
    arn: input.arn,
    id: input.id,
    type: input.type,
    service: input.service,
    accountId: input.accountId,
    region: input.region || GLOBAL_REGION,
    name: input.name,
    tags: {},
    rawJson: input.rawJson ?? {},
    lastUpdated: Date.now()
  };
}

export function getValueByPath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = source;

  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Builds an AWS Console URL for any resource. Falls back to the service's
 * home page (scoped to the resource's region) when no deep-link pattern is
 * known for the type. The returned URL is never `undefined` — callers can
 * rely on it to always produce something openable in a browser.
 *
 * Plugins can still override this by defining `buildConsoleUrl` on their
 * `ResourceTypeDefinition`; this helper is the fallback used by the
 * "Open in AWS Console" action when no type-specific builder is registered.
 */
export function buildGenericConsoleUrl(resource: ResourceNode): string {
  const region = resource.region === GLOBAL_REGION ? "us-east-1" : resource.region;
  const regionQuery = `region=${encodeURIComponent(region)}`;
  const nameOrId = resource.name || resource.id;
  const encodedArn = encodeURIComponent(resource.arn);

  switch (resource.type) {
    case ResourceTypes.vpc:
      return `https://${region}.console.aws.amazon.com/vpcconsole/home?${regionQuery}#VpcDetails:VpcId=${resource.id}`;
    case ResourceTypes.subnet:
      return `https://${region}.console.aws.amazon.com/vpcconsole/home?${regionQuery}#SubnetDetails:subnetId=${resource.id}`;
    case ResourceTypes.securityGroup:
      return `https://${region}.console.aws.amazon.com/ec2/home?${regionQuery}#SecurityGroup:groupId=${resource.id}`;
    case ResourceTypes.vpcEndpoint:
      return `https://${region}.console.aws.amazon.com/vpcconsole/home?${regionQuery}#EndpointDetails:vpcEndpointId=${resource.id}`;
    case ResourceTypes.ec2Instance:
      return `https://${region}.console.aws.amazon.com/ec2/home?${regionQuery}#InstanceDetails:instanceId=${resource.id}`;
    case ResourceTypes.iamRole:
      return `https://console.aws.amazon.com/iam/home#/roles/${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.s3Bucket:
      return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.kmsKey:
      return `https://${region}.console.aws.amazon.com/kms/home?${regionQuery}#/kms/keys/${resource.id}`;
    case ResourceTypes.lambdaFunction:
      return `https://${region}.console.aws.amazon.com/lambda/home?${regionQuery}#/functions/${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.ecsCluster:
      return `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${encodeURIComponent(nameOrId)}?${regionQuery}`;
    case ResourceTypes.ecrRepository:
      return `https://${region}.console.aws.amazon.com/ecr/repositories/private/${resource.accountId}/${encodeURIComponent(nameOrId)}?${regionQuery}`;
    case ResourceTypes.rdsInstance:
      return `https://${region}.console.aws.amazon.com/rds/home?${regionQuery}#database:id=${encodeURIComponent(resource.id)};is-cluster=false`;
    case ResourceTypes.rdsCluster:
      return `https://${region}.console.aws.amazon.com/rds/home?${regionQuery}#database:id=${encodeURIComponent(resource.id)};is-cluster=true`;
    case ResourceTypes.rdsSnapshot:
    case ResourceTypes.rdsClusterSnapshot:
      return `https://${region}.console.aws.amazon.com/rds/home?${regionQuery}#snapshots-list:`;
    case ResourceTypes.dynamodbTable:
      return `https://${region}.console.aws.amazon.com/dynamodbv2/home?${regionQuery}#table?name=${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.redshiftCluster:
      return `https://${region}.console.aws.amazon.com/redshiftv2/home?${regionQuery}#cluster-details?cluster=${encodeURIComponent(resource.id)}`;
    case ResourceTypes.eventBridgeBus:
      return `https://${region}.console.aws.amazon.com/events/home?${regionQuery}#/eventbus/${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.eventBridgeRule:
      return `https://${region}.console.aws.amazon.com/events/home?${regionQuery}#/rules`;
    case ResourceTypes.mskCluster:
      return `https://${region}.console.aws.amazon.com/msk/home?${regionQuery}#/cluster/${encodedArn}/view`;
    case ResourceTypes.alb:
      return `https://${region}.console.aws.amazon.com/ec2/home?${regionQuery}#LoadBalancers:search=${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.targetGroup:
      return `https://${region}.console.aws.amazon.com/ec2/home?${regionQuery}#TargetGroups:search=${encodeURIComponent(nameOrId)}`;
    case ResourceTypes.sfnStateMachine:
      return `https://${region}.console.aws.amazon.com/states/home?${regionQuery}#/statemachines/view/${encodedArn}`;
    case ResourceTypes.logGroup:
      return `https://${region}.console.aws.amazon.com/cloudwatch/home?${regionQuery}#logsV2:log-groups/log-group/${encodeURIComponent(nameOrId).replace(/%2F/g, '$252F')}`;
    case ResourceTypes.vpcLatticeServiceNetwork:
      return `https://${region}.console.aws.amazon.com/vpc/home?${regionQuery}#ServiceNetworks`;
    case ResourceTypes.vpcLatticeService:
      return `https://${region}.console.aws.amazon.com/vpc/home?${regionQuery}#LatticeServices`;
    default:
      // Generic service-home fallback. Works for any resource: we know the
      // AWS service prefix from `resource.service`, so open the service's
      // console landing page in the right region. Not deep-linked, but it
      // always puts the user one click away from the resource.
      return `https://${region}.console.aws.amazon.com/${encodeURIComponent(resource.service)}/home?${regionQuery}`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function getRawString(resource: ResourceNode, key: string): string | undefined {
  const value = resource.rawJson[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildAwsCliCommand(service: string, operation: string, args: string[], region?: string): string {
  const parts = ["aws", service, operation, ...args];
  if (region) {
    parts.push("--region", shellQuote(region));
  }
  return parts.join(" ");
}

function resolveCliRegion(resource: ResourceNode): string | undefined {
  if (resource.type === ResourceTypes.s3Bucket) {
    return getRawString(resource, "BucketRegion");
  }

  return resource.region !== GLOBAL_REGION ? resource.region : undefined;
}

function extractEcsClusterIdentifier(resource: ResourceNode): string | undefined {
  const rawClusterArn = getRawString(resource, "clusterArn") ?? getRawString(resource, "ClusterArn");
  if (rawClusterArn) {
    return rawClusterArn;
  }

  const resourcePart = resource.arn.split(":").slice(5).join(":");
  if (!resourcePart.startsWith("service/") && !resourcePart.startsWith("task/")) {
    return undefined;
  }

  const [, clusterName] = resourcePart.split("/");
  return clusterName || undefined;
}

function normalizeLogGroupIdentifier(arn: string): string {
  return arn.endsWith(":*") ? arn.slice(0, -2) : arn;
}

/**
 * Builds a best-effort AWS CLI command for a specific resource type.
 *
 * The returned command is intended for copy/paste convenience in a terminal,
 * so some resource types use a "get" operation instead of a literal
 * "describe" call when that is the canonical AWS CLI shape.
 */
export function buildGenericCliDescribeCommand(resource: ResourceNode): string | undefined {
  const region = resolveCliRegion(resource);

  switch (resource.type) {
    case ResourceTypes.vpc:
      return buildAwsCliCommand("ec2", "describe-vpcs", ["--vpc-ids", shellQuote(resource.id)], region);
    case ResourceTypes.subnet:
      return buildAwsCliCommand("ec2", "describe-subnets", ["--subnet-ids", shellQuote(resource.id)], region);
    case ResourceTypes.securityGroup:
      return buildAwsCliCommand("ec2", "describe-security-groups", ["--group-ids", shellQuote(resource.id)], region);
    case ResourceTypes.vpcEndpoint:
      return buildAwsCliCommand("ec2", "describe-vpc-endpoints", ["--vpc-endpoint-ids", shellQuote(resource.id)], region);
    case ResourceTypes.vpcLatticeServiceNetwork:
      return buildAwsCliCommand(
        "vpc-lattice",
        "get-service-network",
        ["--service-network-identifier", shellQuote(resource.arn || resource.id)],
        region
      );
    case ResourceTypes.vpcLatticeService:
      return buildAwsCliCommand(
        "vpc-lattice",
        "get-service",
        ["--service-identifier", shellQuote(resource.arn || resource.id)],
        region
      );
    case ResourceTypes.ec2Instance:
      return buildAwsCliCommand("ec2", "describe-instances", ["--instance-ids", shellQuote(resource.id)], region);
    case ResourceTypes.iamRole:
      return buildAwsCliCommand("iam", "get-role", ["--role-name", shellQuote(resource.name || resource.id)]);
    case ResourceTypes.s3Bucket:
      return buildAwsCliCommand("s3api", "get-bucket-location", ["--bucket", shellQuote(resource.id)], region);
    case ResourceTypes.kmsKey:
      return buildAwsCliCommand("kms", "describe-key", ["--key-id", shellQuote(resource.arn || resource.id)], region);
    case ResourceTypes.lambdaFunction:
      return buildAwsCliCommand("lambda", "get-function", ["--function-name", shellQuote(resource.id)], region);
    case ResourceTypes.ecsCluster:
      return buildAwsCliCommand("ecs", "describe-clusters", ["--clusters", shellQuote(resource.arn || resource.id)], region);
    case ResourceTypes.ecsService: {
      const cluster = extractEcsClusterIdentifier(resource);
      if (!cluster) {
        return undefined;
      }
      return buildAwsCliCommand(
        "ecs",
        "describe-services",
        ["--cluster", shellQuote(cluster), "--services", shellQuote(resource.arn || resource.id)],
        region
      );
    }
    case ResourceTypes.ecsTask: {
      const cluster = extractEcsClusterIdentifier(resource);
      if (!cluster) {
        return undefined;
      }
      return buildAwsCliCommand(
        "ecs",
        "describe-tasks",
        ["--cluster", shellQuote(cluster), "--tasks", shellQuote(resource.arn || resource.id)],
        region
      );
    }
    case ResourceTypes.ecrRepository:
      return buildAwsCliCommand("ecr", "describe-repositories", ["--repository-names", shellQuote(resource.id)], region);
    case ResourceTypes.rdsInstance:
      return buildAwsCliCommand("rds", "describe-db-instances", ["--db-instance-identifier", shellQuote(resource.id)], region);
    case ResourceTypes.rdsCluster:
      return buildAwsCliCommand("rds", "describe-db-clusters", ["--db-cluster-identifier", shellQuote(resource.id)], region);
    case ResourceTypes.rdsSnapshot:
      return buildAwsCliCommand("rds", "describe-db-snapshots", ["--db-snapshot-identifier", shellQuote(resource.id)], region);
    case ResourceTypes.rdsClusterSnapshot:
      return buildAwsCliCommand(
        "rds",
        "describe-db-cluster-snapshots",
        ["--db-cluster-snapshot-identifier", shellQuote(resource.id)],
        region
      );
    case ResourceTypes.dynamodbTable:
      return buildAwsCliCommand("dynamodb", "describe-table", ["--table-name", shellQuote(resource.id)], region);
    case ResourceTypes.redshiftCluster:
      return buildAwsCliCommand("redshift", "describe-clusters", ["--cluster-identifier", shellQuote(resource.id)], region);
    case ResourceTypes.eventBridgeBus:
      return buildAwsCliCommand("events", "describe-event-bus", ["--name", shellQuote(resource.id)], region);
    case ResourceTypes.eventBridgeRule: {
      const args = ["--name", shellQuote(resource.id)];
      const eventBusName = getRawString(resource, "EventBusName");
      if (eventBusName) {
        args.push("--event-bus-name", shellQuote(eventBusName));
      }
      return buildAwsCliCommand("events", "describe-rule", args, region);
    }
    case ResourceTypes.mskCluster:
      return buildAwsCliCommand("kafka", "describe-cluster-v2", ["--cluster-arn", shellQuote(resource.arn)], region);
    case ResourceTypes.sqsQueue: {
      const queueUrl = getRawString(resource, "QueueUrl");
      if (!queueUrl) {
        return undefined;
      }
      return buildAwsCliCommand(
        "sqs",
        "get-queue-attributes",
        ["--queue-url", shellQuote(queueUrl), "--attribute-names", "All"],
        region
      );
    }
    case ResourceTypes.alb:
      return buildAwsCliCommand("elbv2", "describe-load-balancers", ["--load-balancer-arns", shellQuote(resource.arn)], region);
    case ResourceTypes.targetGroup:
      return buildAwsCliCommand("elbv2", "describe-target-groups", ["--target-group-arns", shellQuote(resource.arn)], region);
    case ResourceTypes.cfnStack:
      return buildAwsCliCommand("cloudformation", "describe-stacks", ["--stack-name", shellQuote(resource.name || resource.id)], region);
    case ResourceTypes.sfnStateMachine:
      return buildAwsCliCommand(
        "stepfunctions",
        "describe-state-machine",
        ["--state-machine-arn", shellQuote(resource.arn)],
        region
      );
    case ResourceTypes.logGroup:
      return buildAwsCliCommand(
        "logs",
        "describe-log-groups",
        ["--log-group-identifiers", shellQuote(normalizeLogGroupIdentifier(resource.arn))],
        region
      );
    default:
      return undefined;
  }
}

/**
 * Parses standard `arn:aws:partition:service:region:account-id:resource` ARNs
 * to recover account and region when resource rows omit them (legacy cache,
 * stub nodes, or odd API shapes).
 */
export function inferScopeFromArn(arn: string): { accountId?: string; region?: string } {
  if (!arn.startsWith("arn:")) {
    return {};
  }
  const parts = arn.split(":");
  if (parts.length < 6) {
    return {};
  }
  const regionCandidate = parts[3];
  const accountCandidate = parts[4];
  const accountId = /^\d{12}$/.test(accountCandidate ?? "") ? accountCandidate : undefined;
  const region =
    regionCandidate && regionCandidate.length > 0 && regionCandidate !== "*"
      ? regionCandidate
      : undefined;
  return { accountId, region };
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "n/a";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
