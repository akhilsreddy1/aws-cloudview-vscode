import { ListTablesCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildDynamodbTableArn } from "../../core/resourceUtils";

const dynamodbDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.dynamodb(scope);
    const resources: ResourceNode[] = [];
    let exclusiveStartTableName: string | undefined;

    do {
      const listResponse = await platform.scheduler.run("dynamodb", "ListTables", () =>
        client.send(new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }))
      );

      for (const tableName of listResponse.TableNames ?? []) {
        try {
          const describeResponse = await platform.scheduler.run("dynamodb", "DescribeTable", () =>
            client.send(new DescribeTableCommand({ TableName: tableName }))
          );

          const table = describeResponse.Table;
          if (!table) { continue; }

          const tableArn = table.TableArn ?? buildDynamodbTableArn(scope.region, scope.accountId, tableName);

          resources.push({
            arn: tableArn,
            id: tableName,
            type: ResourceTypes.dynamodbTable,
            service: "dynamodb",
            accountId: scope.accountId,
            region: scope.region,
            name: tableName,
            tags: {},
            rawJson: table as Record<string, unknown>,
            lastUpdated: Date.now(),
          });
        } catch {
          // skip tables that fail to describe
        }
      }

      exclusiveStartTableName = listResponse.LastEvaluatedTableName;
    } while (exclusiveStartTableName);

    return resources;
  },
};

export function registerDynamodbPlugin(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.dynamodbTable,
    service: "dynamodb",
    serviceLabel: "DynamoDB",
    displayName: "DynamoDB Table",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: dynamodbDiscoverer,
    detailFields: [
      { label: "Table Name", path: "id", source: "resource" },
      { label: "Status", path: "TableStatus", source: "raw" },
      { label: "Item Count", path: "ItemCount", source: "raw" },
      { label: "Size Bytes", path: "TableSizeBytes", source: "raw" },
      { label: "Billing Mode", path: "BillingModeSummary.BillingMode", source: "raw" },
    ],
  });
}
