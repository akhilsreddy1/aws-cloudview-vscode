import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, buildLambdaArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const DEPRECATED_RUNTIMES = new Set([
  "nodejs14.x", "nodejs16.x",
  "python3.7", "python3.8",
  "java8", "java8.al2",
  "dotnetcore3.1", "dotnet6",
  "go1.x",
  "ruby2.7",
  "provided",
]);

const lambdaDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.lambda(scope);
    const resources: ResourceNode[] = [];
    let marker: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("lambda", "ListFunctions", () =>
        client.send(new ListFunctionsCommand({ Marker: marker }))
      );

      for (const func of response.Functions ?? []) {
        const functionName = func.FunctionName!;
        const functionArn = func.FunctionArn ?? buildLambdaArn(scope.region, scope.accountId, functionName);
        const tags = toTagMap(undefined);

        const runtime = func.Runtime ?? "";
        const codeSize = func.CodeSize ?? 0;
        const layers = func.Layers ?? [];
        const ephemeralStorage = func.EphemeralStorage?.Size ?? 512;
        const snapStart = func.SnapStart?.ApplyOn ?? "None";
        const architectures = func.Architectures ?? ["x86_64"];

        const enriched: Record<string, unknown> = {
          ...(func as Record<string, unknown>),
          CodeSizeMB: Math.round((codeSize / 1_048_576) * 100) / 100,
          IsDeprecatedRuntime: DEPRECATED_RUNTIMES.has(runtime),
          HasLayers: layers.length > 0,
          LayerCount: layers.length,
          EphemeralStorageGB: Math.round((ephemeralStorage / 1024) * 100) / 100,
          SnapStartEnabled: snapStart !== "None" && snapStart !== undefined,
          ArchSummary: architectures.join(", "),
        };

        resources.push({
          arn: functionArn,
          id: functionName,
          type: ResourceTypes.lambdaFunction,
          service: "lambda",
          accountId: scope.accountId,
          region: scope.region,
          name: functionName,
          tags,
          rawJson: enriched,
          lastUpdated: Date.now(),
        });
      }

      marker = response.NextMarker;
      pages++;
      if (shouldStopPagination({
        pages, nextToken: marker, label: "lambda:ListFunctions",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (marker);

    return resources;
  },
};

export function registerLambdaPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.lambdaFunction,
    service: "lambda",
    serviceLabel: "Lambda",
    displayName: "Lambda Function",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: lambdaDiscoverer,
    getTreeDescription: (resource) => resource.rawJson.Runtime as string | undefined,
  });
}
