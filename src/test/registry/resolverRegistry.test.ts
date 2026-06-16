import { describe, it, expect, beforeEach } from "vitest";
import { ResolverRegistry } from "../../registry/resolverRegistry";
import type { RelationshipResolver } from "../../core/contracts";

function makeResolver(overrides: Partial<RelationshipResolver> & { id: string; sourceType: string; relationshipType: string }): RelationshipResolver {
  return {
    ttlSeconds: 300,
    resolve: async () => ({ nodes: [], edges: [] }),
    ...overrides,
  };
}

describe("ResolverRegistry", () => {
  let registry: ResolverRegistry;

  beforeEach(() => {
    registry = new ResolverRegistry();
  });

  it("registers and retrieves resolvers for a source type", () => {
    const resolver = makeResolver({ id: "r1", sourceType: "AWS::EC2::Instance", relationshipType: "attachment" });
    registry.register(resolver);

    const result = registry.getForSourceType("AWS::EC2::Instance");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r1");
  });

  it("returns multiple resolvers for the same sourceType sorted by relationshipType", () => {
    registry.register(makeResolver({ id: "r1", sourceType: "AWS::EC2::Instance", relationshipType: "securityGroup" }));
    registry.register(makeResolver({ id: "r2", sourceType: "AWS::EC2::Instance", relationshipType: "attachment" }));
    registry.register(makeResolver({ id: "r3", sourceType: "AWS::EC2::Instance", relationshipType: "subnet" }));

    const result = registry.getForSourceType("AWS::EC2::Instance");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.relationshipType)).toEqual(["attachment", "securityGroup", "subnet"]);
  });

  it("returns an empty array for an unknown sourceType", () => {
    expect(registry.getForSourceType("AWS::Unknown::Type")).toEqual([]);
  });
});
