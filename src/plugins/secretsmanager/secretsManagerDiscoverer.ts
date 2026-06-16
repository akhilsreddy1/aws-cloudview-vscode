import {
  ListSecretsCommand,
  type SecretListEntry,
} from "@aws-sdk/client-secrets-manager";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildSecretsManagerSecretArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Discovers Secrets Manager secrets. We only list metadata here —
 * `GetSecretValue` is never called during discovery, so secret values never
 * touch the local cache. Values are fetched on demand (and masked by default)
 * by the secret value panel.
 */
const secretsManagerDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.secretsManager(scope);
    const resources: ResourceNode[] = [];

    const secrets: SecretListEntry[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("secretsmanager", "ListSecrets", () =>
        client.send(new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 }))
      );
      for (const s of resp.SecretList ?? []) secrets.push(s);
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "secretsmanager:ListSecrets",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    for (const secret of secrets) {
      if (!secret.Name) continue;
      if (context.cancellation?.isCancellationRequested) break;

      const arn = secret.ARN ?? buildSecretsManagerSecretArn(scope.region, scope.accountId, secret.Name);
      const tags: Record<string, string> = {};
      for (const t of secret.Tags ?? []) {
        if (t.Key) tags[t.Key] = t.Value ?? "";
      }

      resources.push({
        arn,
        id: secret.Name,
        type: ResourceTypes.secretsManagerSecret,
        service: "secretsmanager",
        accountId: scope.accountId,
        region: scope.region,
        name: secret.Name,
        tags,
        rawJson: {
          SecretName: secret.Name,
          Description: secret.Description,
          KmsKeyId: secret.KmsKeyId,
          RotationEnabled: secret.RotationEnabled ?? false,
          RotationLambdaARN: secret.RotationLambdaARN,
          LastChangedDate: secret.LastChangedDate ? secret.LastChangedDate.toISOString() : undefined,
          LastAccessedDate: secret.LastAccessedDate ? secret.LastAccessedDate.toISOString() : undefined,
          LastRotatedDate: secret.LastRotatedDate ? secret.LastRotatedDate.toISOString() : undefined,
          CreatedDate: secret.CreatedDate ? secret.CreatedDate.toISOString() : undefined,
          // Soft hint: secrets created by other AWS services (e.g. RDS managed
          // master passwords) carry an owning-service prefix.
          OwningService: secret.OwningService,
          PrimaryRegion: secret.PrimaryRegion,
        },
        lastUpdated: Date.now(),
      });
    }

    return resources;
  },
};

export function registerSecretsManagerPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.secretsManagerSecret,
    service: "secretsmanager",
    serviceLabel: "Secrets Manager",
    displayName: "Secret",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: secretsManagerDiscoverer,
    getTreeDescription: (resource) => {
      const rotation = resource.rawJson.RotationEnabled as boolean | undefined;
      return rotation ? "rotation on" : undefined;
    },
    detailFields: [
      { label: "Secret Name", path: "id", source: "resource" },
      { label: "Description", path: "Description", source: "raw" },
      { label: "ARN", path: "arn", source: "resource" },
      { label: "KMS Key", path: "KmsKeyId", source: "raw" },
      { label: "Rotation Enabled", path: "RotationEnabled", source: "raw" },
      { label: "Last Changed", path: "LastChangedDate", source: "raw" },
      { label: "Last Accessed", path: "LastAccessedDate", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/secretsmanager/secret?name=${encodeURIComponent(resource.id)}&region=${resource.region}`,
  });
}
