import { describe, it, expect, vi, beforeEach } from "vitest";
import { AwsRequestScheduler } from "../../aws/throttler";
import type { CloudViewConfiguration, Logger } from "../../core/contracts";

function makeConfig(): CloudViewConfiguration {
  return {
    regions: ["us-east-1"],
    defaultTtlSeconds: 300,
    globalConcurrency: 4,
    serviceConcurrency: { ec2: 2 },
    defaultGraphExpandDepth: 1,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("AwsRequestScheduler", () => {
  let scheduler: AwsRequestScheduler;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    scheduler = new AwsRequestScheduler(() => makeConfig(), logger);
  });

  it("executes a successful task and returns the result", async () => {
    const result = await scheduler.run("ec2", "DescribeInstances", async () => "success");
    expect(result).toBe("success");
  });

  it("retries on throttle errors", async () => {
    let attempt = 0;
    const originalSleep = (scheduler as any).sleep.bind(scheduler);
    (scheduler as any).sleep = vi.fn().mockResolvedValue(undefined);

    const result = await scheduler.run("ec2", "DescribeInstances", async () => {
      attempt += 1;
      if (attempt < 3) {
        const error = new Error("Rate exceeded");
        error.name = "ThrottlingException";
        throw error;
      }
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(attempt).toBe(3);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("throws non-retryable errors immediately", async () => {
    await expect(
      scheduler.run("ec2", "DescribeInstances", async () => {
        throw new Error("AccessDenied");
      })
    ).rejects.toThrow("AccessDenied");
  });

  it("retries on network errors (ECONNRESET)", async () => {
    (scheduler as any).sleep = vi.fn().mockResolvedValue(undefined);
    let attempt = 0;

    const result = await scheduler.run("ec2", "op", async () => {
      attempt += 1;
      if (attempt < 2) {
        const err: any = new Error("connection reset");
        err.code = "ECONNRESET";
        throw err;
      }
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(attempt).toBe(2);
  });

  it("retries on HTTP 5xx responses via $metadata.httpStatusCode", async () => {
    (scheduler as any).sleep = vi.fn().mockResolvedValue(undefined);
    let attempt = 0;

    const result = await scheduler.run("ec2", "op", async () => {
      attempt += 1;
      if (attempt < 2) {
        const err: any = new Error("internal error");
        err.$metadata = { httpStatusCode: 503 };
        throw err;
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("picks up globalConcurrency changes without rebuild", async () => {
    let limit = 1;
    const dyn = new AwsRequestScheduler(() => ({ ...makeConfig(), globalConcurrency: limit }), logger);

    let concurrent = 0;
    let maxConcurrent = 0;
    const task = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return "done";
    };

    // First wave with the tight limit.
    await Promise.all([dyn.run("ec2", "op", task), dyn.run("ec2", "op", task)]);
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    // Raise the limit and run another wave; the same scheduler picks it up.
    limit = 3;
    concurrent = 0;
    maxConcurrent = 0;
    await Promise.all(Array.from({ length: 4 }, () => dyn.run("ec2", "op", task)));
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("concurrent tasks respect global semaphore limit", async () => {
    const config = makeConfig();
    config.globalConcurrency = 2;
    const narrowScheduler = new AwsRequestScheduler(() => config, logger);

    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrent -= 1;
      return "done";
    };

    const tasks = Array.from({ length: 6 }, () => narrowScheduler.run("ec2", "op", task));
    await Promise.all(tasks);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
