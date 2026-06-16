import { formatValue, getValueByPath, inferScopeFromArn } from "../core/resourceUtils";
import type { ResourceDetailsPayload, ResourceNode } from "../core/contracts";
import type { CloudViewPlatform } from "../core/platform";

export class ResourceDetailsPanel {
  public constructor(private readonly platform: CloudViewPlatform) {}

  public build(resource: ResourceNode): ResourceDetailsPayload {
    const definition = this.platform.resourceRegistry.get(resource.type);
    const inferred = inferScopeFromArn(resource.arn);
    const accountDisplay = resource.accountId || inferred.accountId || "";
    const regionDisplay = resource.region || inferred.region || "";
    const metadata = [
      { label: "ARN", value: resource.arn },
      { label: "Type", value: definition?.displayName ?? resource.type },
      { label: "Account", value: formatValue(accountDisplay) },
      { label: "Region", value: formatValue(regionDisplay) }
    ];

    for (const field of definition?.detailFields ?? []) {
      const source = field.source === "resource" ? (resource as unknown as Record<string, unknown>) : resource.rawJson;
      metadata.push({
        label: field.label,
        value: formatValue(getValueByPath(source, field.path))
      });
    }

    return {
      arn: resource.arn,
      title: resource.name || resource.id,
      subtitle: `${definition?.displayName ?? resource.type} • ${resource.id}`,
      metadata,
      tags: Object.entries(resource.tags)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
      // Get the actions for the resource from the action registry for the resource type
      // Ex: if the resource is an ECS service, get the actions for the ECS service from the action registry
      actions: this.platform.actionRegistry
        .getActionsForResource(resource, this.platform)
        .map((action) => ({ id: action.id, title: action.title }))
    };
  }
}
