/**
 * Canonical string constants for every AWS resource type supported by the
 * extension. Use these instead of raw strings throughout the codebase to
 * avoid typos and enable easy search/refactor.
 *
 * Each value follows the dot-namespaced convention:
 * `aws.<service>.<resource-kind>` (e.g. `"aws.ec2.instance"`).
 */
export const ResourceTypes = {
  vpc: "aws.ec2.vpc",
  subnet: "aws.ec2.subnet",
  vpcEndpoint: "aws.ec2.vpc-endpoint",
  securityGroup: "aws.ec2.security-group",
  vpcLatticeServiceNetwork: "aws.vpc-lattice.service-network",
  vpcLatticeService: "aws.vpc-lattice.service",
  ec2Instance: "aws.ec2.instance",
  iamRole: "aws.iam.role",
  s3Bucket: "aws.s3.bucket",
  kmsKey: "aws.kms.key",
  lambdaFunction: "aws.lambda.function",
  ecsCluster: "aws.ecs.cluster",
  ecsService: "aws.ecs.service",
  ecsTask: "aws.ecs.task",
  ecrRepository: "aws.ecr.repository",
  rdsInstance: "aws.rds.instance",
  rdsCluster: "aws.rds.cluster",
  rdsSnapshot: "aws.rds.snapshot",
  rdsClusterSnapshot: "aws.rds.cluster-snapshot",
  dynamodbTable: "aws.dynamodb.table",
  redshiftCluster: "aws.redshift.cluster",
  eventBridgeBus: "aws.eventbridge.bus",
  eventBridgeRule: "aws.eventbridge.rule",
  mskCluster: "aws.msk.cluster",
  sqsQueue: "aws.sqs.queue",
  alb: "aws.elbv2.load-balancer",
  targetGroup: "aws.elbv2.target-group",
  cfnStack: "aws.cloudformation.stack",
  sfnStateMachine: "aws.stepfunctions.state-machine",
  logGroup: "aws.logs.log-group",
} as const;

export type ResourceType = (typeof ResourceTypes)[keyof typeof ResourceTypes];
