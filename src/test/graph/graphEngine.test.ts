import { describe, it, expect, beforeEach, vi } from "vitest";
import { GraphEngine } from "../../graph/graphEngine";
import type { ResourceNode, Edge } from "../../core/contracts";
import type { CloudViewPlatform } from "../../core/platform";

function makeResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    arn: "arn:aws:ec2:us-east-1:123:instance/i-root",
    id: "i-root",
    type: "AWS::EC2::Instance",
    service: "ec2",
    accountId: "123",
    region: "us-east-1",
    name: "root-instance",
    tags: {},
    rawJson: {},
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    fromArn: "arn:aws:ec2:us-east-1:123:instance/i-root",
    toArn: "arn:aws:ec2:us-east-1:123:sg/sg-1",
    relationshipType: "securityGroup",
    metadataJson: {},
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makeMockPlatform(): CloudViewPlatform {
  return {
    resourceRepo: {
      getByArn: vi.fn(),
      getByArns: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      upsertMany: vi.fn(),
      isStale: vi.fn().mockReturnValue(false),
      listByScope: vi.fn().mockResolvedValue([]),
    },
    edgeRepo: {
      listOutgoing: vi.fn().mockResolvedValue([]),
      listConnected: vi.fn().mockResolvedValue([]),
      replaceRelationshipSet: vi.fn(),
      upsertMany: vi.fn(),
      hasFreshOutgoing: vi.fn().mockResolvedValue(false),
    },
    resolverRegistry: {
      getForSourceType: vi.fn().mockReturnValue([]),
    },
    resourceRegistry: {
      get: vi.fn().mockReturnValue(undefined),
    },
    discoveryJobRepo: {
      shouldRun: vi.fn().mockResolvedValue(false),
      markRunning: vi.fn(),
      markSuccess: vi.fn(),
      markFailure: vi.fn(),
    },
    sessionManager: {
      findProfileNameByAccountId: vi.fn().mockResolvedValue(undefined),
      getSelectedProfileSessions: vi.fn().mockResolvedValue([]),
      getConfiguredRegions: vi.fn().mockReturnValue([]),
    },
    discoveryCoordinator: {
      refreshDefinition: vi.fn(),
    },
    graphRepo: {
      traverseFrom: vi.fn().mockResolvedValue({ arns: [], edges: [] }),
      subgraph: vi.fn().mockResolvedValue({ arns: [], edges: [] }),
      pathBetween: vi.fn().mockResolvedValue([]),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as CloudViewPlatform;
}

describe("GraphEngine", () => {
  let platform: CloudViewPlatform;
  let engine: GraphEngine;

  beforeEach(() => {
    platform = makeMockPlatform();
    engine = new GraphEngine(platform);
  });

  it("expand returns empty when root not in repo", async () => {
    vi.mocked(platform.resourceRepo.getByArn).mockResolvedValue(undefined);

    const result = await engine.expand("arn:aws:missing", 1);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.rootArn).toBe("arn:aws:missing");
  });

  it("expand returns root node when no resolvers registered", async () => {
    const root = makeResource();
    vi.mocked(platform.resourceRepo.getByArn).mockResolvedValue(root);
    vi.mocked(platform.resolverRegistry.getForSourceType).mockReturnValue([]);
    vi.mocked(platform.edgeRepo.listOutgoing).mockResolvedValue([]);
    vi.mocked(platform.resourceRepo.getByArns).mockResolvedValue([]);

    const result = await engine.expand(root.arn, 1);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].arn).toBe(root.arn);
    expect(result.edges).toHaveLength(0);
  });

  it("search delegates to resourceRepo", async () => {
    const resources = [makeResource({ name: "found" })];
    vi.mocked(platform.resourceRepo.search).mockResolvedValue(resources);

    const result = await engine.search("found", 10);
    expect(result).toEqual(resources);
    expect(platform.resourceRepo.search).toHaveBeenCalledWith("found", 10);
  });

  it("neighbors returns connected nodes", async () => {
    const root = makeResource();
    const neighbor = makeResource({
      arn: "arn:aws:ec2:us-east-1:123:sg/sg-1",
      id: "sg-1",
      type: "AWS::EC2::SecurityGroup",
      name: "my-sg",
    });
    const edge = makeEdge();

    vi.mocked(platform.resourceRepo.getByArn).mockResolvedValue(root);
    // `neighbors` now walks via graphRepo.traverseFrom — return the edge
    // and the neighbor arn so the engine hydrates it from resourceRepo.
    (platform.graphRepo.traverseFrom as ReturnType<typeof vi.fn>).mockResolvedValue({
      arns: [root.arn, neighbor.arn],
      edges: [edge],
    });
    vi.mocked(platform.resourceRepo.getByArns).mockResolvedValue([neighbor]);

    const result = await engine.neighbors(root.arn);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes.map((n) => n.arn).sort()).toEqual([root.arn, neighbor.arn].sort());
  });

  it("neighbors returns empty for unknown arn", async () => {
    vi.mocked(platform.resourceRepo.getByArn).mockResolvedValue(undefined);

    const result = await engine.neighbors("arn:aws:unknown");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});
