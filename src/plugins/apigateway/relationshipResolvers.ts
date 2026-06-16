import { GetResourcesCommand, GetMethodCommand } from "@aws-sdk/client-api-gateway";
import { GetIntegrationsCommand, GetRoutesCommand } from "@aws-sdk/client-apigatewayv2";
import type { RelationshipResolver, RelationshipResolution, ResolverContext, ResourceNode, Edge } from "../../core/contracts";
import type { ResolverRegistry } from "../../registry/resolverRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { makeStubResource } from "../../core/resourceUtils";

/**
 * Parse a Lambda function ARN out of an API Gateway integration URI. AWS
 * formats these as:
 *   arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<lambda-arn>/invocations
 * We extract the embedded function ARN. Returns undefined for non-Lambda
 * integrations (HTTP, AWS service, VPC link, MOCK).
 */
function extractLambdaArn(integrationUri: string | undefined): string | undefined {
  if (!integrationUri) return undefined;
  // Two forms are common:
  //  1. The path-encoded URI above
  //  2. A plain function ARN (rare; some SDK paths normalize to this)
  const pathMatch = integrationUri.match(/\/functions\/(arn:aws:lambda:[^/]+:[^:]+:function:[^/]+)/);
  if (pathMatch) return pathMatch[1];
  if (integrationUri.startsWith("arn:aws:lambda:") && integrationUri.includes(":function:")) {
    return integrationUri.split("/")[0]; // strip any trailing /invocations
  }
  return undefined;
}

/** Parse the log group ARN out of a stage's access-log destination ARN. */
function logGroupArnFromAccessLog(destinationArn: string | undefined): string | undefined {
  if (!destinationArn) return undefined;
  // Format: arn:aws:logs:<region>:<acct>:log-group:<name>:*  (sometimes without the `:*` suffix)
  if (destinationArn.startsWith("arn:aws:logs:") && destinationArn.includes(":log-group:")) {
    return destinationArn.replace(/:\*$/, "");
  }
  return undefined;
}

function logGroupStub(arn: string, accountId: string, region: string): ResourceNode {
  // The ARN format guarantees these path segments exist; index 6 is the group name.
  const name = arn.split(":log-group:")[1]?.split(":")[0] ?? "";
  return makeStubResource({
    arn,
    id: name,
    type: ResourceTypes.logGroup,
    service: "logs",
    accountId,
    region,
    name,
  });
}

function lambdaStub(arn: string): ResourceNode {
  // Lambda ARN: arn:aws:lambda:<region>:<acct>:function:<name>
  const parts = arn.split(":");
  const region = parts[3] ?? "";
  const accountId = parts[4] ?? "";
  const name = parts[6] ?? "";
  return makeStubResource({
    arn,
    id: name,
    type: ResourceTypes.lambdaFunction,
    service: "lambda",
    accountId,
    region,
    name,
  });
}

// ─── REST API (v1) → Lambda integrations ─────────────────────────────────

/**
 * For REST APIs, integrations are per-method. To find them we have to:
 *   1. GetResources (all the /paths)
 *   2. For each resource × method, GetMethod (returns the integration)
 *
 * That's O(resources × methods) calls per API — easily 50–200 for a
 * medium API. We accept the cost during a force refresh (this resolver
 * is TTL-gated like all others) but bail early via cancellation if the
 * user hits Cancel on the global refresh notification.
 */
const restApiLambdaResolver: RelationshipResolver = {
  id: "apigateway-rest-lambda-integrations",
  sourceType: ResourceTypes.apiGatewayRestApi,
  relationshipType: "invokes",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source, platform } = context;
    const scope = { profileName: "", accountId: source.accountId, region: source.region };
    const profileName = await platform.sessionManager.findProfileNameByAccountId(source.accountId);
    if (!profileName) return { nodes: [], edges: [] };
    scope.profileName = profileName;

    const client = await platform.awsClientFactory.apiGateway(scope);
    const apiId = source.id;

    // Pull all resources for the API (paginated).
    const resourceItems: Array<{ id: string; methods: string[] }> = [];
    let position: string | undefined;
    try {
      do {
        const resp = await platform.scheduler.run("apigateway", "GetResources", () =>
          client.send(new GetResourcesCommand({ restApiId: apiId, position, limit: 500 }))
        );
        for (const r of resp.items ?? []) {
          if (r.id && r.resourceMethods) {
            resourceItems.push({ id: r.id, methods: Object.keys(r.resourceMethods) });
          }
        }
        position = resp.position;
      } while (position);
    } catch (err) {
      platform.logger.warn(`GetResources failed for REST api ${apiId}: ${err instanceof Error ? err.message : String(err)}`);
      return { nodes: [], edges: [] };
    }

    const lambdaArns = new Set<string>();
    for (const { id, methods } of resourceItems) {
      for (const httpMethod of methods) {
        try {
          const methodResp = await platform.scheduler.run("apigateway", "GetMethod", () =>
            client.send(new GetMethodCommand({ restApiId: apiId, resourceId: id, httpMethod }))
          );
          const lambdaArn = extractLambdaArn(methodResp.methodIntegration?.uri);
          if (lambdaArn) lambdaArns.add(lambdaArn);
        } catch {
          // permission denied on one method shouldn't kill the rest
        }
      }
    }

    const nodes: ResourceNode[] = [];
    const edges: Edge[] = [];
    for (const arn of lambdaArns) {
      nodes.push(lambdaStub(arn));
      edges.push({
        fromArn: source.arn,
        toArn: arn,
        relationshipType: "invokes",
        metadataJson: { via: "api-gateway-integration" },
        lastUpdated: Date.now(),
      });
    }
    return { nodes, edges };
  },
};

// ─── v2 API → Lambda integrations ────────────────────────────────────────

const v2ApiLambdaResolver: RelationshipResolver = {
  id: "apigatewayv2-lambda-integrations",
  sourceType: ResourceTypes.apiGatewayV2Api,
  relationshipType: "invokes",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source, platform } = context;
    const profileName = await platform.sessionManager.findProfileNameByAccountId(source.accountId);
    if (!profileName) return { nodes: [], edges: [] };
    const scope = { profileName, accountId: source.accountId, region: source.region };

    const client = await platform.awsClientFactory.apiGatewayV2(scope);
    const apiId = source.id;

    // v2 has a flat GetIntegrations call — no per-route loop needed.
    const lambdaArns = new Set<string>();
    let nextToken: string | undefined;
    try {
      do {
        const resp = await platform.scheduler.run("apigatewayv2", "GetIntegrations", () =>
          client.send(new GetIntegrationsCommand({ ApiId: apiId, NextToken: nextToken, MaxResults: "100" }))
        );
        for (const integ of resp.Items ?? []) {
          // Lambda integrations have IntegrationType=AWS_PROXY and IntegrationUri set to the function ARN
          // (or the invoke ARN, which contains the function ARN). HTTP/SERVICE/MOCK integrations are skipped.
          if (integ.IntegrationType !== "AWS_PROXY") continue;
          const lambdaArn = extractLambdaArn(integ.IntegrationUri);
          if (lambdaArn) lambdaArns.add(lambdaArn);
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    } catch (err) {
      platform.logger.warn(`GetIntegrations failed for v2 api ${apiId}: ${err instanceof Error ? err.message : String(err)}`);
      return { nodes: [], edges: [] };
    }

    const nodes: ResourceNode[] = [];
    const edges: Edge[] = [];
    for (const arn of lambdaArns) {
      nodes.push(lambdaStub(arn));
      edges.push({
        fromArn: source.arn,
        toArn: arn,
        relationshipType: "invokes",
        metadataJson: { via: "api-gateway-v2-integration" },
        lastUpdated: Date.now(),
      });
    }
    return { nodes, edges };
  },
};

// ─── Stage → log group (access logs) ─────────────────────────────────────

const stageLogsResolverFor = (sourceType: string, id: string): RelationshipResolver => ({
  id,
  sourceType,
  relationshipType: "access-logs",
  ttlSeconds: 600,
  async resolve(context: ResolverContext): Promise<RelationshipResolution> {
    const { source } = context;
    const logGroupArn = logGroupArnFromAccessLog(
      source.rawJson.AccessLogSettingsDestinationArn as string | undefined,
    );
    if (!logGroupArn) return { nodes: [], edges: [] };
    return {
      nodes: [logGroupStub(logGroupArn, source.accountId, source.region)],
      edges: [{
        fromArn: source.arn,
        toArn: logGroupArn,
        relationshipType: "access-logs",
        metadataJson: { via: "api-gateway-access-logs" },
        lastUpdated: Date.now(),
      }],
    };
  },
});

const restStageLogsResolver = stageLogsResolverFor(ResourceTypes.apiGatewayStage, "apigateway-rest-stage-logs");
const v2StageLogsResolver = stageLogsResolverFor(ResourceTypes.apiGatewayV2Stage, "apigatewayv2-stage-logs");

// ─── Routes drilldown (exposed for the future per-API panel) ─────────────

/**
 * For the v0.0.18 "view routes & integrations" panel, callers can fetch
 * the per-route integration mapping on demand. Exported here so the panel
 * doesn't need to re-implement the API call shapes.
 */
export interface RouteIntegration {
  method: string;
  path: string;
  integrationType?: string;
  integrationTarget?: string;
  authorizationType?: string;
}

export async function fetchV2Routes(
  context: ResolverContext,
  apiId: string,
): Promise<RouteIntegration[]> {
  const { source, platform } = context;
  const profileName = await platform.sessionManager.findProfileNameByAccountId(source.accountId);
  if (!profileName) return [];
  const scope = { profileName, accountId: source.accountId, region: source.region };
  const client = await platform.awsClientFactory.apiGatewayV2(scope);

  const out: RouteIntegration[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await platform.scheduler.run("apigatewayv2", "GetRoutes", () =>
      client.send(new GetRoutesCommand({ ApiId: apiId, NextToken: nextToken, MaxResults: "100" }))
    );
    for (const r of resp.Items ?? []) {
      // RouteKey is `METHOD /path` or `$default`
      const [method, ...pathParts] = (r.RouteKey ?? "").split(" ");
      out.push({
        method: method || "ANY",
        path: pathParts.join(" ") || "/",
        integrationTarget: r.Target,
        authorizationType: r.AuthorizationType,
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return out;
}

// ─── Registration ────────────────────────────────────────────────────────

export function registerApiGatewayRelationshipResolvers(registry: ResolverRegistry): void {
  registry.register(restApiLambdaResolver);
  registry.register(v2ApiLambdaResolver);
  registry.register(restStageLogsResolver);
  registry.register(v2StageLogsResolver);
}
