import { describe, expect, it } from "vitest";
import type { ResourceNode } from "../../core/contracts";
import { buildGenericCliDescribeCommand } from "../../core/resourceUtils";
import { ResourceTypes } from "../../core/resourceTypes";

function makeResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
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
    ...overrides,
  };
}

describe("buildGenericCliDescribeCommand", () => {
  it("builds ECS service commands using the owning cluster", () => {
    const resource = makeResource({
      arn: "arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service",
      id: "my-service",
      type: ResourceTypes.ecsService,
      service: "ecs",
      rawJson: {
        clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster",
      },
    });

    expect(buildGenericCliDescribeCommand(resource)).toBe(
      "aws ecs describe-services --cluster 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster' --services 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service' --region 'us-east-1'"
    );
  });

  it("uses log group identifiers without the trailing wildcard suffix", () => {
    const resource = makeResource({
      arn: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/demo:*",
      id: "/aws/lambda/demo",
      type: ResourceTypes.logGroup,
      service: "logs",
      name: "/aws/lambda/demo",
    });

    expect(buildGenericCliDescribeCommand(resource)).toBe(
      "aws logs describe-log-groups --log-group-identifiers 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/demo' --region 'us-east-1'"
    );
  });

  it("includes the event bus name when describing an EventBridge rule", () => {
    const resource = makeResource({
      arn: "arn:aws:events:us-east-1:123456789012:rule/custom-bus/nightly-job",
      id: "nightly-job",
      type: ResourceTypes.eventBridgeRule,
      service: "eventbridge",
      rawJson: {
        EventBusName: "custom-bus",
      },
    });

    expect(buildGenericCliDescribeCommand(resource)).toBe(
      "aws events describe-rule --name 'nightly-job' --event-bus-name 'custom-bus' --region 'us-east-1'"
    );
  });

  it("returns undefined when the resource type is unsupported", () => {
    const resource = makeResource({ type: "aws.unknown.resource" });

    expect(buildGenericCliDescribeCommand(resource)).toBeUndefined();
  });
});
