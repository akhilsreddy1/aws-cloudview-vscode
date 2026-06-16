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
  // ── API Gateway (two products under one UX) ────────────────────────────
  // v1 / REST APIs — `apigateway` service namespace.
  apiGatewayRestApi: "aws.apigateway.rest-api",
  apiGatewayStage: "aws.apigateway.stage",
  // v2 / HTTP + WebSocket APIs — `apigatewayv2` service namespace, but we
  // surface both products under the `apigateway` UI service for consistency
  // with how AWS Console groups them.
  apiGatewayV2Api: "aws.apigatewayv2.api",
  apiGatewayV2Stage: "aws.apigatewayv2.stage",
  // Glue ETL jobs.
  glueJob: "aws.glue.job",
  // Glue Data Catalog crawlers.
  glueCrawler: "aws.glue.crawler",
  // Glue workflows (orchestrate jobs + crawlers via triggers).
  glueWorkflow: "aws.glue.workflow",
  // Glue triggers (schedule/condition/on-demand/event).
  glueTrigger: "aws.glue.trigger",
  // Secrets Manager.
  secretsManagerSecret: "aws.secretsmanager.secret",
} as const;

export type ResourceType = (typeof ResourceTypes)[keyof typeof ResourceTypes];
