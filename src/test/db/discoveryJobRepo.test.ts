import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SqliteDatabase } from "../../db/sqlite";
import { DiscoveryJobRepo } from "../../db/discoveryJobRepo";
import type { DiscoveryJob } from "../../core/contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeJob(scopeKey: string): DiscoveryJob {
  return {
    scopeKey,
    jobType: "resource-discovery",
    profileName: "default",
    accountId: "123456789012",
    region: "us-east-1",
    service: "ec2",
    resourceType: "AWS::EC2::Instance",
    status: "running",
    metadataJson: {},
  };
}

describe("DiscoveryJobRepo", () => {
  let sqliteDb: SqliteDatabase;
  let repo: DiscoveryJobRepo;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudview-djob-test-"));
    sqliteDb = new SqliteDatabase();
    const db = await sqliteDb.initialize(tmpDir);
    repo = new DiscoveryJobRepo(db);
  });

  afterAll(async () => {
    await sqliteDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shouldRun returns true when no job exists", async () => {
    const result = await repo.shouldRun("nonexistent-scope", 300, false);
    expect(result).toBe(true);
  });

  it("shouldRun returns false when job recently succeeded (within TTL)", async () => {
    const scopeKey = "test|success|scope";
    await repo.markRunning(makeJob(scopeKey));
    await repo.markSuccess(scopeKey, 300);

    const result = await repo.shouldRun(scopeKey, 300, false);
    expect(result).toBe(false);
  });

  it("shouldRun returns true when force=true", async () => {
    const scopeKey = "test|force|scope";
    await repo.markRunning(makeJob(scopeKey));
    await repo.markSuccess(scopeKey, 300);

    const result = await repo.shouldRun(scopeKey, 300, true);
    expect(result).toBe(true);
  });

  it("markRunning + markSuccess + shouldRun sequence works correctly", async () => {
    const scopeKey = "test|sequence|scope";

    expect(await repo.shouldRun(scopeKey, 300, false)).toBe(true);

    await repo.markRunning(makeJob(scopeKey));
    await repo.markSuccess(scopeKey, 300);

    expect(await repo.shouldRun(scopeKey, 300, false)).toBe(false);
  });

  it("markFailure sets a short retry window (30s)", async () => {
    const scopeKey = "test|failure|scope";
    await repo.markRunning(makeJob(scopeKey));
    await repo.markFailure(scopeKey, new Error("API error"));

    const shouldRunNow = await repo.shouldRun(scopeKey, 300, false);
    expect(shouldRunNow).toBe(false);

    const shouldRunForced = await repo.shouldRun(scopeKey, 300, true);
    expect(shouldRunForced).toBe(true);
  });

  it("markFailure increments consecutive_failures and extends backoff", async () => {
    const scopeKey = "test|expbackoff|scope";
    await repo.markRunning(makeJob(scopeKey));
    await repo.markFailure(scopeKey, new Error("fail 1"));
    expect(await repo.getConsecutiveFailures(scopeKey)).toBe(1);

    await repo.markRunning(makeJob(scopeKey));
    await repo.markFailure(scopeKey, new Error("fail 2"));
    expect(await repo.getConsecutiveFailures(scopeKey)).toBe(2);

    await repo.markRunning(makeJob(scopeKey));
    await repo.markSuccess(scopeKey, 300);
    expect(await repo.getConsecutiveFailures(scopeKey)).toBe(0);
  });

  it("stale running locks are treated as eligible for re-run", async () => {
    const scopeKey = "test|stale|scope";
    await repo.markRunning(makeJob(scopeKey));

    // Simulate the row having been started 20 minutes ago (beyond the 10-minute stale threshold).
    const db = (repo as unknown as { db: { run: (sql: string, args: unknown[]) => Promise<void> } }).db;
    await db.run(
      "UPDATE discovery_jobs SET started_at = ? WHERE scope_key = ?",
      [Date.now() - 20 * 60 * 1000, scopeKey]
    );

    expect(await repo.shouldRun(scopeKey, 300, false)).toBe(true);
  });

  it("saveCheckpoint / getCheckpoint round-trip works", async () => {
    const scopeKey = "test|checkpoint|scope";
    await repo.markRunning(makeJob(scopeKey));

    expect(await repo.getCheckpoint(scopeKey)).toBeUndefined();

    await repo.saveCheckpoint(scopeKey, "page-42");
    expect(await repo.getCheckpoint(scopeKey)).toBe("page-42");

    await repo.saveCheckpoint(scopeKey, undefined);
    expect(await repo.getCheckpoint(scopeKey)).toBeUndefined();
  });

  it("markSuccess clears the checkpoint and resets consecutive_failures", async () => {
    const scopeKey = "test|success-clears|scope";
    await repo.markRunning(makeJob(scopeKey));
    await repo.saveCheckpoint(scopeKey, "resume-token");
    await repo.markFailure(scopeKey, new Error("boom"));
    await repo.markRunning(makeJob(scopeKey));
    await repo.markSuccess(scopeKey, 300);

    expect(await repo.getCheckpoint(scopeKey)).toBeUndefined();
    expect(await repo.getConsecutiveFailures(scopeKey)).toBe(0);
  });
});
