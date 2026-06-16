import { describe, it, expect, beforeEach, vi } from "vitest";
import { ResourceRegistry } from "../../registry/resourceRegistry";
import type { Logger, ResourceNode, ResourceTypeDefinition } from "../../core/contracts";
import { ResourceTypes } from "../../core/resourceTypes";

function makeDefinition(overrides: Partial<ResourceTypeDefinition> & { type: string; service: string }): ResourceTypeDefinition {
  return {
    displayName: overrides.type,
    serviceLabel: overrides.service,
    scope: "regional",
    ttlSeconds: 300,
    discoverer: { discover: async () => [] },
    ...overrides,
  };
}

describe("ResourceRegistry", () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  it("registers and retrieves a definition by type", () => {
    const def = makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "EC2 Instance" });
    registry.register(def);
    expect(registry.get("AWS::EC2::Instance")).toBe(def);
  });

  it("returns undefined for an unknown type", () => {
    expect(registry.get("AWS::Unknown::Type")).toBeUndefined();
  });

  it("getByService returns only definitions for that service, sorted by displayName", () => {
    registry.register(makeDefinition({ type: "AWS::EC2::VPC", service: "ec2", displayName: "VPC" }));
    registry.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "EC2 Instance" }));
    registry.register(makeDefinition({ type: "AWS::S3::Bucket", service: "s3", displayName: "S3 Bucket" }));

    const ec2Defs = registry.getByService("ec2");
    expect(ec2Defs).toHaveLength(2);
    expect(ec2Defs[0].displayName).toBe("EC2 Instance");
    expect(ec2Defs[1].displayName).toBe("VPC");
  });

  it("all() returns all definitions sorted by displayName", () => {
    registry.register(makeDefinition({ type: "AWS::S3::Bucket", service: "s3", displayName: "S3 Bucket" }));
    registry.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "EC2 Instance" }));
    registry.register(makeDefinition({ type: "AWS::Lambda::Function", service: "lambda", displayName: "Lambda Function" }));

    const all = registry.all();
    expect(all).toHaveLength(3);
    expect(all.map((d) => d.displayName)).toEqual(["EC2 Instance", "Lambda Function", "S3 Bucket"]);
  });

  it("listServices() returns unique services sorted by label", () => {
    registry.register(makeDefinition({ type: "AWS::S3::Bucket", service: "s3", serviceLabel: "S3" }));
    registry.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", serviceLabel: "EC2" }));
    registry.register(makeDefinition({ type: "AWS::EC2::VPC", service: "ec2", serviceLabel: "EC2" }));

    const services = registry.listServices();
    expect(services).toEqual([
      { id: "ec2", label: "EC2" },
      { id: "s3", label: "S3" },
    ]);
  });

  it("supports multiple types for the same service", () => {
    registry.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "Instance" }));
    registry.register(makeDefinition({ type: "AWS::EC2::VPC", service: "ec2", displayName: "VPC" }));
    registry.register(makeDefinition({ type: "AWS::EC2::SecurityGroup", service: "ec2", displayName: "Security Group" }));

    expect(registry.getByService("ec2")).toHaveLength(3);
    expect(registry.listServices()).toHaveLength(1);
  });

  it("warns when a duplicate type is registered", () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reg = new ResourceRegistry(logger);

    reg.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "First" }));
    reg.register(makeDefinition({ type: "AWS::EC2::Instance", service: "ec2", displayName: "Second" }));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate registration"));
    expect(reg.get("AWS::EC2::Instance")!.displayName).toBe("Second");
  });

  it("adds a default CLI builder for supported resources", () => {
    registry.register(makeDefinition({ type: ResourceTypes.ec2Instance, service: "ec2", displayName: "EC2 Instance" }));

    const resource: ResourceNode = {
      arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-abc123",
      id: "i-abc123",
      type: ResourceTypes.ec2Instance,
      service: "ec2",
      accountId: "123456789012",
      region: "us-east-1",
      name: "i-abc123",
      tags: {},
      rawJson: {},
      lastUpdated: Date.now(),
    };

    expect(registry.get(ResourceTypes.ec2Instance)?.buildCliDescribeCommand?.(resource)).toBe(
      "aws ec2 describe-instances --instance-ids 'i-abc123' --region 'us-east-1'"
    );
  });

  it("preserves an explicitly registered CLI builder", () => {
    const customBuilder = vi.fn(() => "custom command");
    const definition = makeDefinition({
      type: ResourceTypes.ec2Instance,
      service: "ec2",
      displayName: "EC2 Instance",
      buildCliDescribeCommand: customBuilder,
    });

    registry.register(definition);

    expect(registry.get(ResourceTypes.ec2Instance)?.buildCliDescribeCommand).toBe(customBuilder);
  });
});
