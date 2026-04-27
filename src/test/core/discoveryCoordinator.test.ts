import { describe, it, expect, beforeEach, vi } from "vitest";
import { DiscoveryCoordinator } from "../../core/discoveryCoordinator";
import type { ResourceNode, ResourceTypeDefinition, AwsScope } from "../../core/contracts";
import type { CloudViewPlatform } from "../../core/platform";

function makeResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    arn: "arn:aws:ec2:us-east-1:123:instance/i-test",
    id: "i-test",
    type: "AWS::EC2::Instance",
    service: "ec2",
    accountId: "123",
    region: "us-east-1",
    name: "test-instance",
    tags: {},
    rawJson: {},
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<ResourceTypeDefinition> = {}): ResourceTypeDefinition {
  return {
    type: "AWS::EC2::Instance",
    service: "ec2",
    serviceLabel: "EC2",
    displayName: "EC2 Instance",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: {
      discover: vi.fn().mockResolvedValue([makeResource()]),
    },
    ...overrides,
  };
}

function makeScope(): AwsScope {
  return {
    profileName: "default",
    accountId: "123",
    region: "us-east-1",
  };
}

function makeMockPlatform(): CloudViewPlatform {
  return {
    resourceRegistry: {
      get: vi.fn(),
      getByService: vi.fn().mockReturnValue([]),
      all: vi.fn().mockReturnValue([]),
      listServices: vi.fn().mockReturnValue([]),
    },
    discoveryJobRepo: {
      shouldRun: vi.fn().mockResolvedValue(true),
      markRunning: vi.fn().mockResolvedValue(undefined),
      markSuccess: vi.fn().mockResolvedValue(undefined),
      markFailure: vi.fn().mockResolvedValue(undefined),
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      getCheckpoint: vi.fn().mockResolvedValue(undefined),
      getConsecutiveFailures: vi.fn().mockResolvedValue(0),
    },
    resourceRepo: {
      upsertMany: vi.fn().mockResolvedValue(undefined),
      listByScope: vi.fn().mockResolvedValue([]),
      getByArn: vi.fn(),
      getByArns: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      isStale: vi.fn().mockReturnValue(false),
      deleteMissingInScope: vi.fn().mockResolvedValue(0),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getConfig: vi.fn().mockReturnValue({
      regions: ["us-east-1"],
      defaultTtlSeconds: 300,
      globalConcurrency: 8,
      serviceConcurrency: {},
      defaultGraphExpandDepth: 1,
    }),
    sessionManager: {
      findProfileNameByAccountId: vi.fn(),
      getSelectedProfileSessions: vi.fn().mockResolvedValue([]),
      getConfiguredRegions: vi.fn().mockReturnValue(["us-east-1"]),
    },
  } as unknown as CloudViewPlatform;
}

describe("DiscoveryCoordinator", () => {
  let platform: CloudViewPlatform;
  let coordinator: DiscoveryCoordinator;

  beforeEach(() => {
    platform = makeMockPlatform();
    coordinator = new DiscoveryCoordinator(platform);
  });

  it("refreshDefinition calls discoverer.discover when shouldRun is true", async () => {
    const definition = makeDefinition();
    const scope = makeScope();
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    const result = await coordinator.refreshDefinition(scope, definition);

    expect(definition.discoverer.discover).toHaveBeenCalledTimes(1);
    expect(platform.discoveryJobRepo.markRunning).toHaveBeenCalled();
    expect(platform.resourceRepo.upsertMany).toHaveBeenCalled();
    expect(platform.discoveryJobRepo.markSuccess).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("AWS::EC2::Instance");
  });

  it("refreshDefinition returns cached results when shouldRun is false", async () => {
    const definition = makeDefinition();
    const scope = makeScope();
    const cached = [makeResource({ name: "cached" })];

    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(false);
    vi.mocked(platform.resourceRepo.listByScope).mockResolvedValue(cached);

    const result = await coordinator.refreshDefinition(scope, definition);

    expect(definition.discoverer.discover).not.toHaveBeenCalled();
    expect(platform.resourceRepo.listByScope).toHaveBeenCalledWith({
      accountId: "123",
      region: "us-east-1",
      service: "ec2",
      type: "AWS::EC2::Instance",
    });
    expect(result).toEqual(cached);
  });

  it("refreshDefinition marks failure on error", async () => {
    const discoverer = { discover: vi.fn().mockRejectedValue(new Error("API failure")) };
    const definition = makeDefinition({ discoverer });
    const scope = makeScope();
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    await expect(coordinator.refreshDefinition(scope, definition)).rejects.toThrow("API failure");

    expect(platform.discoveryJobRepo.markFailure).toHaveBeenCalled();
    expect(platform.logger.error).toHaveBeenCalled();
  });

  it("refreshServiceScope filters definitions by scope (regional vs global)", async () => {
    const regionalDef = makeDefinition({ type: "AWS::EC2::Instance", scope: "regional" });
    const globalDef = makeDefinition({ type: "AWS::IAM::Role", scope: "global", service: "iam" });

    vi.mocked(platform.resourceRegistry.getByService).mockReturnValue([regionalDef, globalDef]);
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    const scope = makeScope();
    await coordinator.refreshServiceScope(scope, "ec2");

    expect(regionalDef.discoverer.discover).toHaveBeenCalled();
    expect(globalDef.discoverer.discover).not.toHaveBeenCalled();
  });

  it("refreshServiceScope includes global definitions when region is 'global'", async () => {
    const regionalDef = makeDefinition({ type: "AWS::EC2::Instance", scope: "regional" });
    const globalDef = makeDefinition({ type: "AWS::IAM::Role", scope: "global", service: "iam" });

    vi.mocked(platform.resourceRegistry.getByService).mockReturnValue([regionalDef, globalDef]);
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    const scope: AwsScope = { profileName: "default", accountId: "123", region: "global" };
    await coordinator.refreshServiceScope(scope, "ec2");

    expect(globalDef.discoverer.discover).toHaveBeenCalled();
    expect(regionalDef.discoverer.discover).not.toHaveBeenCalled();
  });

  it("refreshServiceScope tolerates partial failures (allSettled)", async () => {
    const goodDef = makeDefinition({
      type: "AWS::EC2::Instance",
      discoverer: { discover: vi.fn().mockResolvedValue([makeResource({ name: "good" })]) },
    });
    const badDef = makeDefinition({
      type: "AWS::EC2::VPC",
      discoverer: { discover: vi.fn().mockRejectedValue(new Error("boom")) },
    });

    vi.mocked(platform.resourceRegistry.getByService).mockReturnValue([goodDef, badDef]);
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    const result = await coordinator.refreshServiceScope(makeScope(), "ec2");

    expect(goodDef.discoverer.discover).toHaveBeenCalled();
    expect(badDef.discoverer.discover).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("good");
    expect(platform.logger.warn).toHaveBeenCalled();
    expect(platform.discoveryJobRepo.markFailure).toHaveBeenCalled();
  });

  it("refreshDefinition tombstones rows not seen in the refresh", async () => {
    const definition = makeDefinition();
    const scope = makeScope();
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    await coordinator.refreshDefinition(scope, definition);

    expect(platform.resourceRepo.deleteMissingInScope).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "123",
        region: "us-east-1",
        type: "AWS::EC2::Instance",
      })
    );
  });

  it("refreshDefinition supports streaming discoverers via persistPage", async () => {
    const pageA = [makeResource({ arn: "arn:a", id: "a" })];
    const pageB = [makeResource({ arn: "arn:b", id: "b" })];
    const definition = makeDefinition({
      discoverer: {
        discover: vi.fn().mockImplementation(async (ctx) => {
          await ctx.persistPage(pageA, "token-1");
          await ctx.persistPage(pageB, undefined);
          return [];
        }),
      },
    });
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);

    const result = await coordinator.refreshDefinition(makeScope(), definition);

    expect(platform.resourceRepo.upsertMany).toHaveBeenCalledWith(pageA);
    expect(platform.resourceRepo.upsertMany).toHaveBeenCalledWith(pageB);
    expect(platform.discoveryJobRepo.saveCheckpoint).toHaveBeenCalledWith(
      expect.any(String),
      "token-1"
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.arn).sort()).toEqual(["arn:a", "arn:b"]);
  });

  it("refreshDefinition passes resumeToken from checkpoint to the discoverer", async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const definition = makeDefinition({ discoverer: { discover } });
    vi.mocked(platform.discoveryJobRepo.shouldRun).mockResolvedValue(true);
    vi.mocked(platform.discoveryJobRepo.getCheckpoint!).mockResolvedValue("prev-token");

    await coordinator.refreshDefinition(makeScope(), definition);

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ resumeToken: "prev-token" })
    );
  });
});
