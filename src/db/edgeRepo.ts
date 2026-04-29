import type { Database } from "sqlite";
import type { Edge } from "../core/contracts";
import { runSerializedTxn } from "./txn";

interface EdgeRow {
  from_arn: string;
  to_arn: string;
  relationship_type: string;
  metadata_json: string;
  last_updated: number;
}

/**
 * SQLite-backed repository for directed {@link Edge} objects.
 * Edges are keyed on `(from_arn, to_arn, relationship_type)`.
 */
export class EdgeRepo {
  public constructor(private readonly db: Database) {}

  /**
   * Upserts the given edges. `account_id` / `region` are denormalized from
   * the `resources` table (joined on `from_arn`) so graph traversals can
   * prune by account without joining at query time. The denormalization is
   * best-effort: if the source resource isn't in the cache yet (stub edge
   * from an as-yet-unresolved resolver), the columns stay NULL and get
   * backfilled on a later upsert once the source appears.
   *
   * The batch runs inside a serialized transaction so concurrent graph
   * expansions and discovery refreshes (which also write edges) never
   * collide on the single SQLite connection.
   */
  public async upsertMany(edges: Edge[]): Promise<void> {
    if (edges.length === 0) {
      return;
    }

    await runSerializedTxn(this.db, async () => {
      for (const edge of edges) {
        await this.db.run(
          `
            INSERT INTO edges (from_arn, to_arn, relationship_type, metadata_json, last_updated, account_id, region)
            VALUES (
              ?, ?, ?, ?, ?,
              (SELECT account_id FROM resources WHERE arn = ?),
              (SELECT region     FROM resources WHERE arn = ?)
            )
            ON CONFLICT(from_arn, to_arn, relationship_type) DO UPDATE SET
              metadata_json = excluded.metadata_json,
              last_updated = excluded.last_updated,
              account_id = COALESCE(excluded.account_id, edges.account_id),
              region     = COALESCE(excluded.region,     edges.region)
          `,
          [
            edge.fromArn, edge.toArn, edge.relationshipType,
            JSON.stringify(edge.metadataJson), edge.lastUpdated,
            edge.fromArn, edge.fromArn
          ]
        );
      }
    });
  }

  /**
   * Atomically replaces all edges of a given `relationshipType` originating
   * from `fromArn`. Used by resolvers to refresh a relationship set without
   * leaving stale edges from a previous run.
   *
   * The DELETE and subsequent INSERTs run inside a single serialized
   * transaction so a graph viewer never sees a half-replaced edge set and
   * concurrent resolvers can't interleave writes.
   */
  public async replaceRelationshipSet(fromArn: string, relationshipType: string, edges: Edge[]): Promise<void> {
    await runSerializedTxn(this.db, async () => {
      await this.db.run(
        "DELETE FROM edges WHERE from_arn = ? AND relationship_type = ?",
        [fromArn, relationshipType]
      );

      for (const edge of edges) {
        await this.db.run(
          `
            INSERT INTO edges (from_arn, to_arn, relationship_type, metadata_json, last_updated, account_id, region)
            VALUES (
              ?, ?, ?, ?, ?,
              (SELECT account_id FROM resources WHERE arn = ?),
              (SELECT region     FROM resources WHERE arn = ?)
            )
            ON CONFLICT(from_arn, to_arn, relationship_type) DO UPDATE SET
              metadata_json = excluded.metadata_json,
              last_updated = excluded.last_updated,
              account_id = COALESCE(excluded.account_id, edges.account_id),
              region     = COALESCE(excluded.region,     edges.region)
          `,
          [
            edge.fromArn, edge.toArn, edge.relationshipType,
            JSON.stringify(edge.metadataJson), edge.lastUpdated,
            edge.fromArn, edge.fromArn
          ]
        );
      }
    });
  }

  /** Returns all edges where `from_arn` matches, ordered by type then target ARN. */
  public async listOutgoing(fromArn: string): Promise<Edge[]> {
    const rows = await this.db.all<EdgeRow[]>("SELECT * FROM edges WHERE from_arn = ? ORDER BY relationship_type, to_arn", [fromArn]);
    return rows.map((row) => this.mapRow(row));
  }

  /** Returns all edges where `arn` appears as either source or target. */
  public async listConnected(arn: string): Promise<Edge[]> {
    const rows = await this.db.all<EdgeRow[]>(
      "SELECT * FROM edges WHERE from_arn = ? OR to_arn = ? ORDER BY last_updated DESC",
      [arn, arn]
    );
    return rows.map((row) => this.mapRow(row));
  }

  public async listByArns(arns: string[]): Promise<Edge[]> {
    if (arns.length === 0) { return []; }
    const placeholders = arns.map(() => "?").join(", ");
    const rows = await this.db.all<EdgeRow[]>(
      `SELECT * FROM edges WHERE from_arn IN (${placeholders}) OR to_arn IN (${placeholders}) ORDER BY relationship_type`,
      [...arns, ...arns]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Returns `true` if at least one outgoing edge of `relationshipType` from
   * `fromArn` was updated within the last `ttlSeconds`. Used by the graph
   * engine to skip re-resolution of recently resolved relationships.
   */
  public async hasFreshOutgoing(fromArn: string, relationshipType: string, ttlSeconds: number): Promise<boolean> {
    const row = await this.db.get<{ last_updated?: number }>(
      "SELECT MAX(last_updated) AS last_updated FROM edges WHERE from_arn = ? AND relationship_type = ?",
      [fromArn, relationshipType]
    );
    return Boolean(row?.last_updated && row.last_updated + ttlSeconds * 1000 > Date.now());
  }

  private mapRow(row: EdgeRow): Edge {
    return {
      fromArn: row.from_arn,
      toArn: row.to_arn,
      relationshipType: row.relationship_type,
      metadataJson: JSON.parse(row.metadata_json) as Record<string, unknown>,
      lastUpdated: row.last_updated
    };
  }
}
