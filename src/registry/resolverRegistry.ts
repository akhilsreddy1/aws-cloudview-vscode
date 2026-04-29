import type { RelationshipResolver } from "../core/contracts";

/**
 * Registry of all {@link RelationshipResolver} objects contributed by plugins.
 * Resolvers are grouped by `sourceType` so the graph engine can quickly find
 * all resolvers applicable to a given resource.
 */
export class ResolverRegistry {
  private readonly resolvers = new Map<string, RelationshipResolver[]>();

  public register(resolver: RelationshipResolver): void {
    const existing = this.resolvers.get(resolver.sourceType) ?? [];
    existing.push(resolver);
    this.resolvers.set(resolver.sourceType, existing);
  }

  /** Returns all resolvers for `sourceType`, sorted by relationship type name. */
  public getForSourceType(sourceType: string): RelationshipResolver[] {
    return [...(this.resolvers.get(sourceType) ?? [])].sort((left, right) => left.relationshipType.localeCompare(right.relationshipType));
  }
}
