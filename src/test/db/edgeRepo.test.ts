import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SqliteDatabase } from "../../db/sqlite";
import { EdgeRepo } from "../../db/edgeRepo";
import type { Edge } from "../../core/contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    fromArn: "arn:aws:ec2:us-east-1:123:instance/i-src",
    toArn: "arn:aws:ec2:us-east-1:123:sg/sg-target",
    relationshipType: "securityGroup",
    metadataJson: {},
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe("EdgeRepo", () => {
  let sqliteDb: SqliteDatabase;
  let repo: EdgeRepo;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudview-edge-test-"));
    sqliteDb = new SqliteDatabase();
    const db = await sqliteDb.initialize(tmpDir);
    repo = new EdgeRepo(db);
  });

  afterAll(async () => {
    await sqliteDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertMany + listOutgoing retrieves stored edges", async () => {
    const edge = makeEdge();
    await repo.upsertMany([edge]);

    const outgoing = await repo.listOutgoing(edge.fromArn);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].toArn).toBe(edge.toArn);
    expect(outgoing[0].relationshipType).toBe("securityGroup");
  });

  it("replaceRelationshipSet removes old edges and inserts new", async () => {
    const fromArn = "arn:aws:ec2:us-east-1:123:instance/i-replace";
    const relType = "subnet";

    const oldEdge = makeEdge({ fromArn, toArn: "arn:aws:ec2:us-east-1:123:subnet/old-sub", relationshipType: relType });
    await repo.upsertMany([oldEdge]);

    let outgoing = await repo.listOutgoing(fromArn);
    expect(outgoing.some((e) => e.toArn === "arn:aws:ec2:us-east-1:123:subnet/old-sub")).toBe(true);

    const newEdge = makeEdge({ fromArn, toArn: "arn:aws:ec2:us-east-1:123:subnet/new-sub", relationshipType: relType });
    await repo.replaceRelationshipSet(fromArn, relType, [newEdge]);

    outgoing = await repo.listOutgoing(fromArn);
    const subnetEdges = outgoing.filter((e) => e.relationshipType === relType);
    expect(subnetEdges).toHaveLength(1);
    expect(subnetEdges[0].toArn).toBe("arn:aws:ec2:us-east-1:123:subnet/new-sub");
  });

  it("listConnected returns edges where arn is source or target", async () => {
    const arn = "arn:aws:ec2:us-east-1:123:instance/i-connected";
    const outEdge = makeEdge({ fromArn: arn, toArn: "arn:aws:ec2:us-east-1:123:sg/sg-out", relationshipType: "outgoing" });
    const inEdge = makeEdge({ fromArn: "arn:aws:ec2:us-east-1:123:vpc/vpc-in", toArn: arn, relationshipType: "incoming" });
    await repo.upsertMany([outEdge, inEdge]);

    const connected = await repo.listConnected(arn);
    expect(connected.length).toBeGreaterThanOrEqual(2);
    expect(connected.some((e) => e.fromArn === arn)).toBe(true);
    expect(connected.some((e) => e.toArn === arn)).toBe(true);
  });

  it("hasFreshOutgoing returns true when edges are within TTL", async () => {
    const fromArn = "arn:aws:ec2:us-east-1:123:instance/i-fresh";
    const edge = makeEdge({ fromArn, toArn: "arn:aws:ec2:us-east-1:123:sg/sg-fresh", relationshipType: "freshRel", lastUpdated: Date.now() });
    await repo.upsertMany([edge]);

    const fresh = await repo.hasFreshOutgoing(fromArn, "freshRel", 300);
    expect(fresh).toBe(true);
  });

  it("hasFreshOutgoing returns false when edges are stale", async () => {
    const fromArn = "arn:aws:ec2:us-east-1:123:instance/i-stale";
    const edge = makeEdge({ fromArn, toArn: "arn:aws:ec2:us-east-1:123:sg/sg-stale", relationshipType: "staleRel", lastUpdated: Date.now() - 600_000 });
    await repo.upsertMany([edge]);

    const fresh = await repo.hasFreshOutgoing(fromArn, "staleRel", 300);
    expect(fresh).toBe(false);
  });

  it("hasFreshOutgoing returns false when no edges exist", async () => {
    const fresh = await repo.hasFreshOutgoing("arn:aws:nonexistent", "unknown", 300);
    expect(fresh).toBe(false);
  });
});
