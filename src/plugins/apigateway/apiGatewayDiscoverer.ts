import {
  GetRestApisCommand,
  GetStagesCommand as GetRestStagesCommand,
} from "@aws-sdk/client-api-gateway";
import {
  GetApisCommand,
  GetStagesCommand as GetV2StagesCommand,
} from "@aws-sdk/client-apigatewayv2";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import {
  buildApiGatewayRestApiArn,
  buildApiGatewayStageArn,
  buildApiGatewayV2ApiArn,
  buildApiGatewayV2StageArn,
} from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

// ─── REST APIs (v1) ──────────────────────────────────────────────────────

const restApiDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.apiGateway(scope);
    const resources: ResourceNode[] = [];

    let position: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("apigateway", "GetRestApis", () =>
        client.send(new GetRestApisCommand({ position, limit: 100 }))
      );
      for (const api of resp.items ?? []) {
        if (!api.id || !api.name) continue;
        const arn = buildApiGatewayRestApiArn(scope.region, scope.accountId, api.id);
        // The execute-api endpoint URL (what callers actually hit) is
        // synthesized from the API id + region; AWS doesn't return it
        // directly on GetRestApis. Stage names are added in the
        // per-API stage call below.
        const endpoint = `https://${api.id}.execute-api.${scope.region}.amazonaws.com`;
        resources.push({
          arn,
          id: api.id,
          type: ResourceTypes.apiGatewayRestApi,
          service: "apigateway",
          accountId: scope.accountId,
          region: scope.region,
          name: api.name,
          tags: (api.tags as Record<string, string>) ?? {},
          rawJson: {
            ApiId: api.id,
            ApiName: api.name,
            ProtocolType: "REST",
            Description: api.description,
            CreatedDate: api.createdDate ? api.createdDate.toISOString() : undefined,
            Endpoint: endpoint,
            EndpointConfiguration: api.endpointConfiguration,
            ApiKeySource: api.apiKeySource,
            DisableExecuteApiEndpoint: api.disableExecuteApiEndpoint ?? false,
            Version: api.version,
            // Filled in by the stage discoverer below for graph/relationship use.
            StageCount: 0,
          },
          lastUpdated: Date.now(),
        });
      }
      position = resp.position;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken: position, label: "apigateway:GetRestApis",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (position);

    return resources;
  },
};

const restStageDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.apiGateway(scope);
    const stages: ResourceNode[] = [];

    // Stages are per-API. List APIs first, then fan out per-api stage calls
    // sequentially through the scheduler so a single bad API doesn't
    // monopolise concurrency.
    const apis = await listAllRestApis(context);
    for (const apiId of apis) {
      let resp;
      try {
        resp = await platform.scheduler.run("apigateway", "GetRestStages", () =>
          client.send(new GetRestStagesCommand({ restApiId: apiId }))
        );
      } catch (err) {
        platform.logger.warn(
          `GetStages (REST) failed for api ${apiId}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      for (const stage of resp.item ?? []) {
        if (!stage.stageName) continue;
        const arn = buildApiGatewayStageArn(scope.region, scope.accountId, apiId, stage.stageName);
        const invokeUrl = `https://${apiId}.execute-api.${scope.region}.amazonaws.com/${stage.stageName}`;
        stages.push({
          arn,
          id: `${apiId}/${stage.stageName}`,
          type: ResourceTypes.apiGatewayStage,
          service: "apigateway",
          accountId: scope.accountId,
          region: scope.region,
          name: `${stage.stageName}`,
          tags: (stage.tags as Record<string, string>) ?? {},
          rawJson: {
            ApiId: apiId,
            StageName: stage.stageName,
            ProtocolType: "REST",
            DeploymentId: stage.deploymentId,
            InvokeUrl: invokeUrl,
            Description: stage.description,
            CacheClusterEnabled: stage.cacheClusterEnabled ?? false,
            CacheClusterSize: stage.cacheClusterSize,
            TracingEnabled: stage.tracingEnabled ?? false,
            CreatedDate: stage.createdDate ? stage.createdDate.toISOString() : undefined,
            LastUpdatedDate: stage.lastUpdatedDate ? stage.lastUpdatedDate.toISOString() : undefined,
            // The MethodSettings field can be substantial (per-method log
            // levels, throttling) but rarely user-facing. Keep it for the
            // raw-JSON drawer but don't promote to columns.
            MethodSettings: stage.methodSettings,
            // Used by the log-group resolver to draw the access-log edge.
            AccessLogSettingsDestinationArn: stage.accessLogSettings?.destinationArn,
            AccessLogSettingsFormat: stage.accessLogSettings?.format,
            WebAclArn: stage.webAclArn,
          },
          lastUpdated: Date.now(),
        });
      }
    }
    return stages;
  },
};

// ─── v2 APIs (HTTP + WebSocket) ──────────────────────────────────────────

const v2ApiDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.apiGatewayV2(scope);
    const resources: ResourceNode[] = [];

    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("apigatewayv2", "GetApis", () =>
        client.send(new GetApisCommand({ NextToken: nextToken, MaxResults: "100" }))
      );
      for (const api of resp.Items ?? []) {
        if (!api.ApiId || !api.Name) continue;
        const arn = buildApiGatewayV2ApiArn(scope.region, scope.accountId, api.ApiId);
        resources.push({
          arn,
          id: api.ApiId,
          type: ResourceTypes.apiGatewayV2Api,
          service: "apigateway",
          accountId: scope.accountId,
          region: scope.region,
          name: api.Name,
          tags: (api.Tags as Record<string, string>) ?? {},
          rawJson: {
            ApiId: api.ApiId,
            ApiName: api.Name,
            // ProtocolType is `HTTP` or `WEBSOCKET` — surfaced in the
            // dashboard so users can tell them apart.
            ProtocolType: api.ProtocolType ?? "HTTP",
            ApiEndpoint: api.ApiEndpoint,
            Description: api.Description,
            CreatedDate: api.CreatedDate ? api.CreatedDate.toISOString() : undefined,
            Version: api.Version,
            DisableExecuteApiEndpoint: api.DisableExecuteApiEndpoint ?? false,
            CorsConfiguration: api.CorsConfiguration,
            RouteSelectionExpression: api.RouteSelectionExpression,
            ApiKeySelectionExpression: api.ApiKeySelectionExpression,
            StageCount: 0,
          },
          lastUpdated: Date.now(),
        });
      }
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "apigatewayv2:GetApis",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

const v2StageDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.apiGatewayV2(scope);
    const stages: ResourceNode[] = [];

    const apis = await listAllV2Apis(context);
    for (const { apiId, endpoint } of apis) {
      let nextToken: string | undefined;
      do {
        let resp;
        try {
          resp = await platform.scheduler.run("apigatewayv2", "GetV2Stages", () =>
            client.send(new GetV2StagesCommand({ ApiId: apiId, NextToken: nextToken, MaxResults: "100" }))
          );
        } catch (err) {
          platform.logger.warn(
            `GetStages (v2) failed for api ${apiId}: ${err instanceof Error ? err.message : String(err)}`
          );
          break;
        }
        for (const stage of resp.Items ?? []) {
          if (!stage.StageName) continue;
          const arn = buildApiGatewayV2StageArn(scope.region, scope.accountId, apiId, stage.StageName);
          // v2 default stage `$default` is invoked at the API root; named
          // stages are invoked at `/<stageName>`.
          const invokeUrl = stage.StageName === "$default"
            ? endpoint
            : `${endpoint}/${stage.StageName}`;
          stages.push({
            arn,
            id: `${apiId}/${stage.StageName}`,
            type: ResourceTypes.apiGatewayV2Stage,
            service: "apigateway",
            accountId: scope.accountId,
            region: scope.region,
            name: stage.StageName,
            tags: (stage.Tags as Record<string, string>) ?? {},
            rawJson: {
              ApiId: apiId,
              StageName: stage.StageName,
              ProtocolType: "V2",
              InvokeUrl: invokeUrl,
              AutoDeploy: stage.AutoDeploy ?? false,
              Description: stage.Description,
              DeploymentId: stage.DeploymentId,
              CreatedDate: stage.CreatedDate ? stage.CreatedDate.toISOString() : undefined,
              LastUpdatedDate: stage.LastUpdatedDate ? stage.LastUpdatedDate.toISOString() : undefined,
              DefaultRouteSettings: stage.DefaultRouteSettings,
              AccessLogSettingsDestinationArn: stage.AccessLogSettings?.DestinationArn,
              AccessLogSettingsFormat: stage.AccessLogSettings?.Format,
            },
            lastUpdated: Date.now(),
          });
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    }
    return stages;
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Lists all REST API ids in the current scope. Shared between the stage
 * discoverer and any future per-API panels so we don't paginate twice.
 */
async function listAllRestApis(context: DiscoveryContext): Promise<string[]> {
  const { scope, platform } = context;
  const client = await platform.awsClientFactory.apiGateway(scope);
  const ids: string[] = [];
  let position: string | undefined;
  do {
    const resp = await platform.scheduler.run("apigateway", "GetRestApis", () =>
      client.send(new GetRestApisCommand({ position, limit: 100 }))
    );
    for (const api of resp.items ?? []) {
      if (api.id) ids.push(api.id);
    }
    position = resp.position;
  } while (position);
  return ids;
}

/** Lists all v2 API ids + endpoint URLs (needed to construct stage invoke URLs). */
async function listAllV2Apis(context: DiscoveryContext): Promise<Array<{ apiId: string; endpoint: string }>> {
  const { scope, platform } = context;
  const client = await platform.awsClientFactory.apiGatewayV2(scope);
  const items: Array<{ apiId: string; endpoint: string }> = [];
  let nextToken: string | undefined;
  do {
    const resp = await platform.scheduler.run("apigatewayv2", "GetApis", () =>
      client.send(new GetApisCommand({ NextToken: nextToken, MaxResults: "100" }))
    );
    for (const api of resp.Items ?? []) {
      if (api.ApiId) {
        items.push({ apiId: api.ApiId, endpoint: api.ApiEndpoint ?? "" });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return items;
}

// ─── Registration ────────────────────────────────────────────────────────

export function registerApiGatewayPlugins(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.apiGatewayRestApi,
    service: "apigateway",
    serviceLabel: "API Gateway",
    displayName: "REST API",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: restApiDiscoverer,
    getTreeDescription: (resource) => "REST",
    detailFields: [
      { label: "Name", path: "name", source: "resource" },
      { label: "API ID", path: "id", source: "resource" },
      { label: "Protocol", path: "ProtocolType", source: "raw" },
      { label: "Endpoint", path: "Endpoint", source: "raw" },
      { label: "Description", path: "Description", source: "raw" },
      { label: "Created", path: "CreatedDate", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/apigateway/main/apis/${resource.id}/resources?api=${resource.id}&region=${resource.region}`,
  });

  registry.register({
    type: ResourceTypes.apiGatewayStage,
    service: "apigateway",
    serviceLabel: "API Gateway",
    displayName: "REST Stage",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: restStageDiscoverer,
    getTreeDescription: (resource) => resource.rawJson.InvokeUrl as string | undefined,
    detailFields: [
      { label: "Stage", path: "StageName", source: "raw" },
      { label: "API ID", path: "ApiId", source: "raw" },
      { label: "Invoke URL", path: "InvokeUrl", source: "raw" },
      { label: "Deployment ID", path: "DeploymentId", source: "raw" },
      { label: "Tracing", path: "TracingEnabled", source: "raw" },
    ],
    buildConsoleUrl: (resource) => {
      const apiId = resource.rawJson.ApiId as string;
      const stageName = resource.rawJson.StageName as string;
      return `https://${resource.region}.console.aws.amazon.com/apigateway/main/apis/${apiId}/stages/${stageName}?api=${apiId}&region=${resource.region}`;
    },
  });

  registry.register({
    type: ResourceTypes.apiGatewayV2Api,
    service: "apigateway",
    serviceLabel: "API Gateway",
    displayName: "HTTP/WS API",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: v2ApiDiscoverer,
    getTreeDescription: (resource) => (resource.rawJson.ProtocolType as string) || "HTTP",
    detailFields: [
      { label: "Name", path: "name", source: "resource" },
      { label: "API ID", path: "id", source: "resource" },
      { label: "Protocol", path: "ProtocolType", source: "raw" },
      { label: "Endpoint", path: "ApiEndpoint", source: "raw" },
      { label: "Description", path: "Description", source: "raw" },
      { label: "Created", path: "CreatedDate", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/apigateway/main/api-detail?api=${resource.id}&region=${resource.region}`,
  });

  registry.register({
    type: ResourceTypes.apiGatewayV2Stage,
    service: "apigateway",
    serviceLabel: "API Gateway",
    displayName: "HTTP/WS Stage",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: v2StageDiscoverer,
    getTreeDescription: (resource) => resource.rawJson.InvokeUrl as string | undefined,
    detailFields: [
      { label: "Stage", path: "StageName", source: "raw" },
      { label: "API ID", path: "ApiId", source: "raw" },
      { label: "Invoke URL", path: "InvokeUrl", source: "raw" },
      { label: "Auto Deploy", path: "AutoDeploy", source: "raw" },
      { label: "Deployment ID", path: "DeploymentId", source: "raw" },
    ],
  });
}
