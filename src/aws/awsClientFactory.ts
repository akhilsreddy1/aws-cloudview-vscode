import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { STSClient } from "@aws-sdk/client-sts";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ECRClient } from "@aws-sdk/client-ecr";
import { RDSClient } from "@aws-sdk/client-rds";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { RedshiftClient } from "@aws-sdk/client-redshift";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { KafkaClient } from "@aws-sdk/client-kafka";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { VPCLatticeClient } from "@aws-sdk/client-vpc-lattice";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { NodeHttpHandler } from "@smithy/node-http-handler";
import { GLOBAL_REGION, type AwsProfileSession, type AwsScope, type Logger } from "../core/contracts";
import type { SessionManager } from "./sessionManager";
import { getSharedNodeHttpHandler, resetSharedNodeHttpHandler } from "./sharedNodeHttpHandler";

/**
 * Creates and caches AWS SDK v3 client instances keyed by
 * `profileName:region:service`. Clients are created lazily on first use
 * and reused for the lifetime of the extension to avoid unnecessary
 * credential resolution overhead.
 *
 * Clients are never explicitly destroyed; VS Code disposes the process
 * when the extension host shuts down.
 */
export class AwsClientFactory {
  private readonly clients = new Map<string, unknown>();

  public constructor(
    private readonly sessionManager: SessionManager,
    private readonly logger?: Logger,
  ) {}

  /**
   * Drops every cached AWS client and the cached proxy handler. Call this
   * when proxy-related VS Code settings change so subsequent client lookups
   * pick up the new configuration without an extension restart.
   */
  public reset(): void {
    this.clients.clear();
    resetSharedNodeHttpHandler();
  }

  /**
   * Builds (once) and returns the shared `NodeHttpHandler`. Always non-null:
   * if a proxy is configured we wire the proxy agents in; otherwise we return
   * a plain handler that still carries the connect/request timeouts.
   * See {@link resolveProxyConfig} for the proxy precedence rules.
   */
  private getRequestHandler(): NodeHttpHandler {
    return getSharedNodeHttpHandler(this.logger);
  }

  /** Common constructor config shared by every SDK client. */
  private clientConfig(region: string, credentials: AwsProfileSession["credentials"]) {
    return { region, credentials, requestHandler: this.getRequestHandler() };
  }

  private async getOrCreate<T>(key: string, factory: () => Promise<T>): Promise<T> {
    let client = this.clients.get(key) as T | undefined;
    if (!client) {
      client = await factory();
      this.clients.set(key, client);
    }
    return client;
  }

  private async resolveAndCreate<T>(
    scope: AwsScope,
    service: string,
    ClientCtor: new (config: ReturnType<AwsClientFactory["clientConfig"]>) => T
  ): Promise<T> {
    const key = `${scope.profileName}:${scope.region}:${service}`;
    return this.getOrCreate(key, async () => {
      const session = await this.sessionManager.resolveProfile(scope.profileName);
      return new ClientCtor(this.clientConfig(scope.region, session.credentials));
    });
  }

  /** Returns a cached EC2 client for the given scope. Used to discover VPCs, subnets, security groups, instances, and VPC endpoints. */
  public async ec2(scope: AwsScope): Promise<EC2Client> {
    return this.resolveAndCreate(scope, "ec2", EC2Client);
  }

  /**
   * IAM is a global service; clients are always created in `us-east-1`
   * regardless of the scope's region.
   */
  public async iam(profileName: string): Promise<IAMClient> {
    const key = `${profileName}:iam`;
    return this.getOrCreate(key, async () => {
      const session = await this.sessionManager.resolveProfile(profileName);
      return new IAMClient(this.clientConfig("us-east-1", session.credentials));
    });
  }

  /**
   * S3 is a global service but bucket operations require a region-specific
   * endpoint. Pass `regionOverride` when the bucket's home region is known
   * (e.g. from `GetBucketLocation`) to avoid redirect errors.
   */
  public async s3(scope: AwsScope, regionOverride?: string): Promise<S3Client> {
    const region = regionOverride && regionOverride !== GLOBAL_REGION
      ? regionOverride
      : scope.region === GLOBAL_REGION ? "us-east-1" : scope.region;
    const key = `${scope.profileName}:${region}:s3`;
    return this.getOrCreate(key, async () => {
      const session = await this.sessionManager.resolveProfile(scope.profileName);
      return new S3Client(this.clientConfig(region, session.credentials));
    });
  }

  /** Returns a cached STS client for `profileName`, used for identity resolution. */
  public async sts(profileName: string): Promise<STSClient> {
    const session = await this.sessionManager.resolveProfile(profileName);
    return this.getStsClient(session);
  }


  /** Returns a cached Lambda client for the given scope. Used to list functions and invoke them from the invoke panel. */
  public async lambda(scope: AwsScope): Promise<LambdaClient> {
    return this.resolveAndCreate(scope, "lambda", LambdaClient);
  }

  /** Returns a cached ECS client for the given scope. Used to discover clusters, services, and tasks. */
  public async ecs(scope: AwsScope): Promise<ECSClient> {
    return this.resolveAndCreate(scope, "ecs", ECSClient);
  }

  /** Returns a cached ECR client for the given scope. Used to list and describe container image repositories. */
  public async ecr(scope: AwsScope): Promise<ECRClient> {
    return this.resolveAndCreate(scope, "ecr", ECRClient);
  }

  /** Returns a cached RDS client for the given scope. Used to discover DB instances, clusters, and snapshots. */
  public async rds(scope: AwsScope): Promise<RDSClient> {
    return this.resolveAndCreate(scope, "rds", RDSClient);
  }

  /** Returns a cached DynamoDB client for the given scope. Used to list tables and their metadata. */
  public async dynamodb(scope: AwsScope): Promise<DynamoDBClient> {
    return this.resolveAndCreate(scope, "dynamodb", DynamoDBClient);
  }

  /** Returns a cached Redshift client for the given scope. Used to list clusters and their VPC/subnet associations. */
  public async redshift(scope: AwsScope): Promise<RedshiftClient> {
    return this.resolveAndCreate(scope, "redshift", RedshiftClient);
  }

  /** Returns a cached EventBridge client for the given scope. Used to discover event buses and rules. */
  public async eventbridge(scope: AwsScope): Promise<EventBridgeClient> {
    return this.resolveAndCreate(scope, "eventbridge", EventBridgeClient);
  }

  /** Returns a cached MSK (Managed Streaming for Kafka) client for the given scope. Used to list Kafka clusters. */
  public async kafka(scope: AwsScope): Promise<KafkaClient> {
    return this.resolveAndCreate(scope, "kafka", KafkaClient);
  }

  /** Returns a cached ELBv2 client for the given scope. Used to discover Application/Network Load Balancers and target groups. */
  public async elbv2(scope: AwsScope): Promise<ElasticLoadBalancingV2Client> {
    return this.resolveAndCreate(scope, "elbv2", ElasticLoadBalancingV2Client);
  }

  /** Returns a cached CloudFormation client for the given scope. Used to list stacks and their resource relationships. */
  public async cloudformation(scope: AwsScope): Promise<CloudFormationClient> {
    return this.resolveAndCreate(scope, "cloudformation", CloudFormationClient);
  }

  /** Returns a cached CloudWatch Logs client for the given scope. Used to list log groups and stream log events in the logs panel. */
  public async cloudwatchLogs(scope: AwsScope): Promise<CloudWatchLogsClient> {
    return this.resolveAndCreate(scope, "cloudwatchLogs", CloudWatchLogsClient);
  }

  /** Returns a cached VPC Lattice client for the given scope. Used to discover service networks and services. */
  public async vpcLattice(scope: AwsScope): Promise<VPCLatticeClient> {
    return this.resolveAndCreate(scope, "vpc-lattice", VPCLatticeClient);
  }

  /** Returns a cached Step Functions (SFN) client for the given scope. Used to list state machines, start executions, and fetch history. */
  public async sfn(scope: AwsScope): Promise<SFNClient> {
    return this.resolveAndCreate(scope, "sfn", SFNClient);
  }

  /** Returns a cached SQS client for the given scope. Used to list queues, peek messages, and redrive DLQs. */
  public async sqs(scope: AwsScope): Promise<SQSClient> {
    return this.resolveAndCreate(scope, "sqs", SQSClient);
  }

  /**
   * Synchronously retrieves or creates an STS client for `session`.
   * Unlike the public `sts()` method, this variant accepts an already-resolved
   * session, avoiding an extra async profile lookup during `getCallerIdentity`.
   */
  private getStsClient(session: AwsProfileSession): STSClient {
    const key = `${session.profileName}:sts`;
    let client = this.clients.get(key) as STSClient | undefined;
    if (!client) {
      client = new STSClient(this.clientConfig(session.defaultRegion ?? "us-east-1", session.credentials));
      this.clients.set(key, client);
    }
    return client;
  }
}
