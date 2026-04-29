import { DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { toTagMap, extractNameTag, buildEcrRepositoryArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const ecrDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.ecr(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("ecr", "DescribeRepositories", () =>
        client.send(new DescribeRepositoriesCommand({ nextToken }))
      );

      for (const repo of response.repositories ?? []) {
        const repoName = repo.repositoryName!;
        const repoArn = repo.repositoryArn ?? buildEcrRepositoryArn(scope.region, scope.accountId, repoName);
        const tags = toTagMap(undefined);
        const name = repoName;

        resources.push({
          arn: repoArn,
          id: repoName,
          type: ResourceTypes.ecrRepository,
          service: "ecr",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags,
          rawJson: repo as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.nextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "ecr:DescribeRepositories",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerEcrPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.ecrRepository,
    service: "ecr",
    serviceLabel: "ECR",
    displayName: "ECR Repository",
    scope: "regional",
    ttlSeconds: 600,
    discoverer: ecrDiscoverer,
    detailFields: [
      { label: "Repository Name", path: "id", source: "resource" },
      { label: "URI", path: "repositoryUri", source: "raw" },
      { label: "Created", path: "createdAt", source: "raw" },
      { label: "Image Tag Mutability", path: "imageTagMutability", source: "raw" },
    ],
  });
}
