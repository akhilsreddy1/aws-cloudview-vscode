import type { Logger, ResourceTypeDefinition } from "../core/contracts";
import { buildGenericCliDescribeCommand } from "../core/resourceUtils";

/** A minimal service descriptor used to populate the service picker in the sidebar. */
export interface ServiceRegistration {
  id: string;
  label: string;
}

/**
 * Registry of all {@link ResourceTypeDefinition} objects contributed by
 * plugins. Definitions are keyed by their `type` string.
 * Plugins call {@link register} once during extension activation via
 * `registerPlatformPlugins`.
 *
 * Duplicate registrations are silently overwritten, but a warning is logged
 * (when a logger is supplied) so plugin conflicts don't go unnoticed.
 */
export class ResourceRegistry {
  private readonly definitions = new Map<string, ResourceTypeDefinition>();

  public constructor(private readonly logger?: Logger) {}

  /**
   * Registers a new resource type definition.
   * @param definition - The resource type definition to register.
   */
  public register(definition: ResourceTypeDefinition): void {
    if (this.definitions.has(definition.type)) {
      this.logger?.warn(
        `ResourceRegistry: duplicate registration for type "${definition.type}" — previous definition overwritten`
      );
    }

    // Ensure a default CLI describe command builder is set if not provided by the plugin.
    definition.buildCliDescribeCommand ??= (resource) => buildGenericCliDescribeCommand(resource);

    this.definitions.set(definition.type, definition);
  }

  public get(type: string): ResourceTypeDefinition | undefined {
    return this.definitions.get(type);
  }

  /** Returns all definitions for `service`, sorted alphabetically by display name. */
  public getByService(service: string): ResourceTypeDefinition[] {
    return Array.from(this.definitions.values())
      .filter((definition) => definition.service === service)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /** Returns all registered definitions sorted alphabetically by display name. */
  public all(): ResourceTypeDefinition[] {
    return Array.from(this.definitions.values()).sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /**
   * Returns a de-duplicated list of services with at least one registered
   * definition, sorted alphabetically by service label.
   */
  public listServices(): ServiceRegistration[] {
    const services = new Map<string, string>();
    for (const definition of this.definitions.values()) {
      services.set(definition.service, definition.serviceLabel);
    }

    return Array.from(services.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }
}
