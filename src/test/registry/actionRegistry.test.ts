import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActionRegistry, registerDefaultActions } from "../../registry/actionRegistry";
import type { ResourceAction, ResourceNode } from "../../core/contracts";
import type { CloudViewPlatform } from "../../core/platform";

function makeResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-abc123",
    id: "i-abc123",
    type: "AWS::EC2::Instance",
    service: "ec2",
    accountId: "123456789012",
    region: "us-east-1",
    name: "my-instance",
    tags: {},
    rawJson: {},
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makePlatform(overrides: Partial<CloudViewPlatform> = {}): CloudViewPlatform {
  return {
    resourceRegistry: { get: vi.fn(() => undefined) },
    ...overrides,
  } as unknown as CloudViewPlatform;
}

describe("ActionRegistry", () => {
  let registry: ActionRegistry;
  const resource = makeResource();
  const platform = makePlatform();

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  it("registers and retrieves a custom action by id", () => {
    const action: ResourceAction = {
      id: "custom.action",
      title: "Custom",
      isAvailable: () => true,
      execute: async () => {},
    };
    registry.register(action);
    expect(registry.getAction("custom.action")).toBe(action);
  });

  it("getActionsForResource filters by isAvailable", () => {
    registry.register({
      id: "a1",
      title: "Available",
      isAvailable: () => true,
      execute: async () => {},
    });
    registry.register({
      id: "a2",
      title: "Not Available",
      isAvailable: () => false,
      execute: async () => {},
    });

    const actions = registry.getActionsForResource(resource, platform);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("a1");
  });

  it("getActionsForResource sorts by order", () => {
    registry.register({ id: "a3", title: "Third", order: 30, isAvailable: () => true, execute: async () => {} });
    registry.register({ id: "a1", title: "First", order: 10, isAvailable: () => true, execute: async () => {} });
    registry.register({ id: "a2", title: "Second", order: 20, isAvailable: () => true, execute: async () => {} });

    const actions = registry.getActionsForResource(resource, platform);
    expect(actions.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("getAction returns undefined for unknown id", () => {
    expect(registry.getAction("nonexistent")).toBeUndefined();
  });
});

describe("registerDefaultActions", () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  it("registers 3 default actions", () => {
    registerDefaultActions(registry);
    expect(registry.getAction("cloudView.copyArn")).toBeDefined();
    expect(registry.getAction("cloudView.openInConsole")).toBeDefined();
    expect(registry.getAction("cloudView.copyCliDescribe")).toBeDefined();
  });

  it("Copy ARN action is available for any resource with an ARN", () => {
    registerDefaultActions(registry);
    const platform = makePlatform();
    const action = registry.getAction("cloudView.copyArn")!;

    const withArn = makeResource({ arn: "arn:aws:s3:::my-bucket" });
    expect(action.isAvailable(withArn, platform)).toBe(true);

    const withoutArn = makeResource({ arn: "" });
    expect(action.isAvailable(withoutArn, platform)).toBe(false);
  });
});
