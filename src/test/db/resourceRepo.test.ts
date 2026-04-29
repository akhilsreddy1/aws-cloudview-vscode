import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SqliteDatabase } from "../../db/sqlite";
import { ResourceRepo } from "../../db/resourceRepo";
import type { ResourceNode } from "../../core/contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeResource(overrides: Partial<ResourceNode> = {}): ResourceNode {
  return {
    arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-abc123",
    id: "i-abc123",
    type: "AWS::EC2::Instance",
    service: "ec2",
    accountId: "123456789012",
    region: "us-east-1",
    name: "my-instance",
    tags: { env: "dev" },
    rawJson: { instanceType: "t3.micro" },
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe("ResourceRepo", () => {
  let sqliteDb: SqliteDatabase;
  let repo: ResourceRepo;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudview-test-"));
    sqliteDb = new SqliteDatabase();
    const db = await sqliteDb.initialize(tmpDir);
    repo = new ResourceRepo(db);
  });

  afterAll(async () => {
    await sqliteDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertMany + getByArn retrieves a stored resource", async () => {
    const resource = makeResource();
    await repo.upsertMany([resource]);

    const result = await repo.getByArn(resource.arn);
    expect(result).toBeDefined();
    expect(result!.arn).toBe(resource.arn);
    expect(result!.name).toBe("my-instance");
    expect(result!.tags).toEqual({ env: "dev" });
    expect(result!.rawJson).toEqual({ instanceType: "t3.micro" });
  });

  it("upsertMany updates existing resources on conflict", async () => {
    const resource = makeResource({ name: "original-name" });
    await repo.upsertMany([resource]);

    const updated = { ...resource, name: "updated-name", lastUpdated: Date.now() + 1000 };
    await repo.upsertMany([updated]);

    const result = await repo.getByArn(resource.arn);
    expect(result!.name).toBe("updated-name");
  });

  it("getByArns retrieves multiple resources", async () => {
    const r1 = makeResource({ arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-multi1", id: "i-multi1", name: "multi-1" });
    const r2 = makeResource({ arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-multi2", id: "i-multi2", name: "multi-2" });
    await repo.upsertMany([r1, r2]);

    const results = await repo.getByArns([r1.arn, r2.arn]);
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(["multi-1", "multi-2"]);
  });

  it("getByArns with empty array returns empty", async () => {
    const results = await repo.getByArns([]);
    expect(results).toEqual([]);
  });

  it("search finds by name (case-insensitive)", async () => {
    const resource = makeResource({ arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-search1", id: "i-search1", name: "SearchableWidget" });
    await repo.upsertMany([resource]);

    const results = await repo.search("searchablewidget");
    expect(results.some((r) => r.id === "i-search1")).toBe(true);
  });

  it("search finds by id (case-insensitive)", async () => {
    const resource = makeResource({ arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-findbyid", id: "i-findbyid", name: "FindById" });
    await repo.upsertMany([resource]);

    const results = await repo.search("I-FINDBYID");
    expect(results.some((r) => r.id === "i-findbyid")).toBe(true);
  });

  it("search finds by arn", async () => {
    const resource = makeResource({ arn: "arn:aws:s3:::unique-search-bucket", id: "unique-search-bucket", service: "s3", type: "AWS::S3::Bucket", name: "unique-search-bucket" });
    await repo.upsertMany([resource]);

    const results = await repo.search("unique-search-bucket");
    expect(results.some((r) => r.arn === "arn:aws:s3:::unique-search-bucket")).toBe(true);
  });

  it("search finds by type (case-insensitive)", async () => {
    const resource = makeResource({ arn: "arn:aws:lambda:us-east-1:123456789012:function:fn1", id: "fn1", type: "AWS::Lambda::Function", service: "lambda", name: "fn1" });
    await repo.upsertMany([resource]);

    const results = await repo.search("lambda::function");
    expect(results.some((r) => r.type === "AWS::Lambda::Function")).toBe(true);
  });

  it("listByScope filters by account and region", async () => {
    const r1 = makeResource({ arn: "arn:aws:ec2:us-east-1:111:instance/i-scope1", id: "i-scope1", accountId: "111", region: "us-east-1", name: "scope1" });
    const r2 = makeResource({ arn: "arn:aws:ec2:eu-west-1:111:instance/i-scope2", id: "i-scope2", accountId: "111", region: "eu-west-1", name: "scope2" });
    await repo.upsertMany([r1, r2]);

    const results = await repo.listByScope({ accountId: "111", region: "us-east-1" });
    expect(results.every((r) => r.region === "us-east-1")).toBe(true);
    expect(results.some((r) => r.id === "i-scope1")).toBe(true);
    expect(results.some((r) => r.id === "i-scope2")).toBe(false);
  });

  it("listByScope filters by service and type", async () => {
    const r1 = makeResource({ arn: "arn:aws:ec2:us-west-2:222:instance/i-svc1", id: "i-svc1", accountId: "222", region: "us-west-2", service: "ec2", type: "AWS::EC2::Instance", name: "svc1" });
    const r2 = makeResource({ arn: "arn:aws:s3:::svc-bucket", id: "svc-bucket", accountId: "222", region: "us-west-2", service: "s3", type: "AWS::S3::Bucket", name: "svc-bucket" });
    await repo.upsertMany([r1, r2]);

    const results = await repo.listByScope({ accountId: "222", region: "us-west-2", service: "ec2", type: "AWS::EC2::Instance" });
    expect(results.every((r) => r.service === "ec2")).toBe(true);
    expect(results.every((r) => r.type === "AWS::EC2::Instance")).toBe(true);
  });

  it("isStale returns true when resource exceeds TTL", () => {
    const old = makeResource({ lastUpdated: Date.now() - 600_000 });
    expect(repo.isStale(old, 300)).toBe(true);
  });

  it("isStale returns false when resource is within TTL", () => {
    const fresh = makeResource({ lastUpdated: Date.now() });
    expect(repo.isStale(fresh, 300)).toBe(false);
  });

  it("deleteMissingInScope tombstones rows not in keepArns", async () => {
    const account = "tombstone-acct";
    const region = "us-east-1";
    const type = "AWS::EC2::Instance";
    const kept = makeResource({
      arn: "arn:aws:ec2:us-east-1:tombstone-acct:instance/i-keep",
      id: "i-keep",
      accountId: account,
      region,
      type,
      name: "keep",
    });
    const removed = makeResource({
      arn: "arn:aws:ec2:us-east-1:tombstone-acct:instance/i-gone",
      id: "i-gone",
      accountId: account,
      region,
      type,
      name: "gone",
    });
    const untouched = makeResource({
      arn: "arn:aws:ec2:us-west-2:tombstone-acct:instance/i-other-region",
      id: "i-other-region",
      accountId: account,
      region: "us-west-2",
      type,
      name: "other-region",
    });
    await repo.upsertMany([kept, removed, untouched]);

    const deleted = await repo.deleteMissingInScope({
      accountId: account,
      region,
      type,
      keepArns: new Set([kept.arn]),
    });

    expect(deleted).toBe(1);
    expect(await repo.getByArn(kept.arn)).toBeDefined();
    expect(await repo.getByArn(removed.arn)).toBeUndefined();
    // Different region — unaffected.
    expect(await repo.getByArn(untouched.arn)).toBeDefined();
  });

  it("concurrent upsertMany + deleteMissingInScope calls do not collide on transactions", async () => {
    // Regression: earlier versions wrapped writes in an explicit
    // BEGIN IMMEDIATE without a write-serializing mutex, so two overlapping
    // callers on the same sqlite connection would throw
    // `SQLITE_ERROR: cannot start a transaction within a transaction`.
    const account = "concurrent-acct";
    const region = "us-east-1";
    const type = "AWS::EC2::Instance";

    const batches: ResourceNode[][] = Array.from({ length: 8 }, (_unused, i) =>
      Array.from({ length: 5 }, (_u, j) =>
        makeResource({
          arn: `arn:aws:ec2:us-east-1:concurrent-acct:instance/i-${i}-${j}`,
          id: `i-${i}-${j}`,
          accountId: account,
          region,
          type,
          name: `inst-${i}-${j}`,
        })
      )
    );

    // Launch all writes concurrently — this is what `Promise.allSettled` in
    // `refreshServiceScope` triggers in production. With the serialized-txn
    // helper every write queues behind the previous one instead of throwing.
    await expect(
      Promise.all([
        ...batches.map((b) => repo.upsertMany(b)),
        repo.deleteMissingInScope({ accountId: account, region, type, keepArns: [] }),
        ...batches.map((b) => repo.upsertMany(b)),
      ])
    ).resolves.toBeDefined();

    // After the last round of upserts the rows should be present.
    const arns = batches.flat().map((r) => r.arn);
    const rows = await repo.getByArns(arns);
    expect(rows.length).toBe(arns.length);
  });

  it("deleteMissingInScope with empty keepArns deletes all rows in scope", async () => {
    const account = "empty-tombstone-acct";
    const region = "eu-central-1";
    const type = "AWS::Lambda::Function";
    const r1 = makeResource({
      arn: "arn:aws:lambda:eu-central-1:empty-tombstone-acct:function:fn-a",
      id: "fn-a",
      accountId: account,
      region,
      type,
      service: "lambda",
    });
    const r2 = makeResource({
      arn: "arn:aws:lambda:eu-central-1:empty-tombstone-acct:function:fn-b",
      id: "fn-b",
      accountId: account,
      region,
      type,
      service: "lambda",
    });
    await repo.upsertMany([r1, r2]);

    const deleted = await repo.deleteMissingInScope({ accountId: account, region, type, keepArns: [] });
    expect(deleted).toBe(2);
    expect(await repo.getByArn(r1.arn)).toBeUndefined();
    expect(await repo.getByArn(r2.arn)).toBeUndefined();
  });
});
