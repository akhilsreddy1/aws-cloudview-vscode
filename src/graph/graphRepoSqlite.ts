import type { Database } from "sqlite";
import type { Edge } from "../core/contracts";
import type {
  GraphPath,
  GraphRepo,
  PathOptions,
  SubgraphOptions,
  SubgraphResult,
  TraversalDirection,
  TraverseOptions
} from "./graphRepo";

interface EdgeRow {
  from_arn: string;
  to_arn: string;
  relationship_type: string;
  metadata_json: string;
  last_updated: number;
  account_id: string | null;
  region: string | null;
}

interface ArnRow { arn: string }
interface CountRow { n: number }
interface PathRow { path: string; depth: number }

const DEFAULT_MAX_NODES = 5000;
const DEFAULT_MAX_PATHS = 5;

/**
 * SQLite `GraphRepo` implementation using recursive CTEs for multi-hop
 * traversals. All graph logic is pushed down to SQL so the query planner
 * can use the covering indexes on `edges`.
 *
 * A string "path" column is threaded through each CTE row to break cycles
 * (`instr(path, '>' || candidate) = 0` rejects revisits) — cheaper than
 * a `visited` map because SQLite has no map primitive, and correct
 * because ARNs cannot contain the `>` separator.
 */
export class SqliteGraphRepo implements GraphRepo {
  public constructor(private readonly db: Database) {}

  public async traverseFrom(rootArn: string, opts: TraverseOptions): Promise<SubgraphResult> {
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const depth = Math.max(0, Math.floor(opts.depth));
    if (depth === 0) {
      return { arns: [rootArn], edges: [] };
    }

    const { joinClause, whereClause, extraParams } = buildFilterFragments({
      direction: opts.direction,
      allowedRelationships: opts.allowedRelationships,
      accountIds: opts.accountIds
    });

    // One CTE per direction, then UNION. We keep (arn, depth, path) tuples and
    // stop recursing when depth >= ?maxDepth. Cycle guard: the `>`-delimited
    // path must not already contain the candidate ARN.
    const sql = `
      WITH RECURSIVE walk(arn, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT ${joinClause.select}, w.depth + 1, w.path || '>' || ${joinClause.select}
        FROM edges e ${joinClause.joinOn} JOIN walk w ON ${joinClause.onExpr}
        WHERE w.depth < ?
          AND instr(w.path, '>' || ${joinClause.select}) = 0
          ${whereClause}
      )
      SELECT DISTINCT arn FROM walk LIMIT ?;
    `;
    const arns = (await this.db.all<ArnRow[]>(sql, [
      rootArn,
      rootArn,
      depth,
      ...extraParams,
      maxNodes
    ])).map((r) => r.arn);

    // Second pass: pull the actual edges connecting the visited node set.
    // This is cheap because arns is already bounded by maxNodes.
    const edges = await this.edgesAmong(arns, opts.allowedRelationships);
    return { arns, edges };
  }

  public async pathBetween(fromArn: string, toArn: string, opts: PathOptions): Promise<GraphPath[]> {
    const maxPaths = opts.maxPaths ?? DEFAULT_MAX_PATHS;
    const depth = Math.max(1, Math.floor(opts.depth));

    const { joinClause, whereClause, extraParams } = buildFilterFragments({
      direction: opts.direction,
      allowedRelationships: opts.allowedRelationships
    });

    // Walk until we reach `toArn`; path is kept as `from>to>to>...` so the
    // caller can reconstruct the edge chain by splitting on `>`.
    const sql = `
      WITH RECURSIVE walk(arn, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT ${joinClause.select}, w.depth + 1, w.path || '>' || ${joinClause.select}
        FROM edges e ${joinClause.joinOn} JOIN walk w ON ${joinClause.onExpr}
        WHERE w.depth < ?
          AND instr(w.path, '>' || ${joinClause.select}) = 0
          ${whereClause}
      )
      SELECT path, depth FROM walk WHERE arn = ? ORDER BY depth LIMIT ?;
    `;
    const rows = await this.db.all<PathRow[]>(sql, [
      fromArn,
      fromArn,
      depth,
      ...extraParams,
      toArn,
      maxPaths
    ]);
    if (rows.length === 0) { return []; }

    // Hydrate each path: for each consecutive ARN pair, find a matching edge.
    const paths: GraphPath[] = [];
    for (const row of rows) {
      const nodes = row.path.split(">");
      const pathEdges: Edge[] = [];
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const edge = await this.findEdgeBetween(nodes[i], nodes[i + 1], opts.direction, opts.allowedRelationships);
        if (edge) { pathEdges.push(edge); }
      }
      if (pathEdges.length > 0) { paths.push(pathEdges); }
    }
    return paths;
  }

  public async subgraph(arns: string[], depth: number, opts?: SubgraphOptions): Promise<SubgraphResult> {
    if (arns.length === 0) { return { arns: [], edges: [] }; }
    const merged = new Set<string>();
    for (const seed of arns) { merged.add(seed); }

    if (depth > 0) {
      // Expand each seed individually then merge; for large seed sets this is
      // dominated by the CTE cost per seed, but keeps the SQL simple and the
      // result identical to a multi-root CTE.
      for (const seed of arns) {
        const walked = await this.traverseFrom(seed, {
          depth,
          direction: opts?.direction ?? "out",
          allowedRelationships: opts?.allowedRelationships,
          accountIds: opts?.accountIds,
          maxNodes: opts?.maxNodes
        });
        for (const a of walked.arns) { merged.add(a); }
      }
    }

    const finalArns = Array.from(merged);
    const edges = await this.edgesAmong(finalArns, opts?.allowedRelationships);
    return { arns: finalArns, edges };
  }

  public async countReachable(rootArn: string, depth: number, direction: TraversalDirection): Promise<number> {
    const clampedDepth = Math.max(0, Math.floor(depth));
    if (clampedDepth === 0) { return 1; }
    const { joinClause, whereClause, extraParams } = buildFilterFragments({ direction });
    const sql = `
      WITH RECURSIVE walk(arn, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT ${joinClause.select}, w.depth + 1, w.path || '>' || ${joinClause.select}
        FROM edges e ${joinClause.joinOn} JOIN walk w ON ${joinClause.onExpr}
        WHERE w.depth < ?
          AND instr(w.path, '>' || ${joinClause.select}) = 0
          ${whereClause}
      )
      SELECT COUNT(DISTINCT arn) AS n FROM walk;
    `;
    const row = await this.db.get<CountRow>(sql, [rootArn, rootArn, clampedDepth, ...extraParams]);
    return row?.n ?? 0;
  }

  /** Returns edges where both endpoints are in `arns`. Chunks the IN list to avoid SQLite's 999-parameter limit. */
  private async edgesAmong(arns: string[], allowedRelationships?: string[]): Promise<Edge[]> {
    if (arns.length === 0) { return []; }
    const CHUNK = 400; // each chunk contributes 2*CHUNK placeholders
    const relClause = allowedRelationships && allowedRelationships.length > 0
      ? `AND relationship_type IN (${allowedRelationships.map(() => "?").join(",")})`
      : "";
    const allEdges: Edge[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < arns.length; i += CHUNK) {
      const slice = arns.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const rows = await this.db.all<EdgeRow[]>(
        `SELECT * FROM edges
         WHERE from_arn IN (${placeholders})
           AND to_arn   IN (${placeholders})
           ${relClause}`,
        [...slice, ...slice, ...(allowedRelationships ?? [])]
      );
      for (const row of rows) {
        const key = `${row.from_arn}|${row.relationship_type}|${row.to_arn}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        allEdges.push(mapEdge(row));
      }
    }
    return allEdges;
  }

  private async findEdgeBetween(
    a: string,
    b: string,
    direction: TraversalDirection,
    allowedRelationships?: string[]
  ): Promise<Edge | undefined> {
    const relClause = allowedRelationships && allowedRelationships.length > 0
      ? `AND relationship_type IN (${allowedRelationships.map(() => "?").join(",")})`
      : "";
    const params = allowedRelationships ?? [];
    let sql: string;
    let args: unknown[];
    if (direction === "in") {
      sql = `SELECT * FROM edges WHERE from_arn = ? AND to_arn = ? ${relClause} LIMIT 1`;
      args = [b, a, ...params];
    } else if (direction === "both") {
      sql = `SELECT * FROM edges WHERE ((from_arn = ? AND to_arn = ?) OR (from_arn = ? AND to_arn = ?)) ${relClause} LIMIT 1`;
      args = [a, b, b, a, ...params];
    } else {
      sql = `SELECT * FROM edges WHERE from_arn = ? AND to_arn = ? ${relClause} LIMIT 1`;
      args = [a, b, ...params];
    }
    const row = await this.db.get<EdgeRow>(sql, args);
    return row ? mapEdge(row) : undefined;
  }
}

/**
 * Builds the direction-specific recursive-CTE fragments:
 * - `joinClause.select`: the expression that becomes the next frontier ARN
 *   (the "other end" of the edge relative to the walk node).
 * - `joinClause.joinOn` / `joinClause.onExpr`: how to join `edges` to the
 *   walk tuple.
 * - `whereClause` + `extraParams`: extra filters (relationship type,
 *   account allowlist).
 */
function buildFilterFragments(opts: {
  direction: TraversalDirection;
  allowedRelationships?: string[];
  accountIds?: string[];
}): {
  joinClause: { select: string; joinOn: string; onExpr: string };
  whereClause: string;
  extraParams: unknown[];
} {
  const whereClauses: string[] = [];
  const extraParams: unknown[] = [];

  if (opts.allowedRelationships && opts.allowedRelationships.length > 0) {
    const placeholders = opts.allowedRelationships.map(() => "?").join(",");
    whereClauses.push(`e.relationship_type IN (${placeholders})`);
    extraParams.push(...opts.allowedRelationships);
  }
  if (opts.accountIds && opts.accountIds.length > 0) {
    const placeholders = opts.accountIds.map(() => "?").join(",");
    // `account_id IS NULL` clause keeps legacy pre-migration edges visible.
    whereClauses.push(`(e.account_id IS NULL OR e.account_id IN (${placeholders}))`);
    extraParams.push(...opts.accountIds);
  }
  const whereClause = whereClauses.length > 0 ? `AND ${whereClauses.join(" AND ")}` : "";

  let joinClause: { select: string; joinOn: string; onExpr: string };
  switch (opts.direction) {
    case "in":
      joinClause = {
        select: "e.from_arn",
        joinOn: "",
        onExpr: "e.to_arn = w.arn"
      };
      break;
    case "both":
      // UNION two directions inside a subquery so the walk sees either end.
      // We materialize that as: join on (e.from_arn = w.arn) then SELECT to_arn,
      // OR join on (e.to_arn = w.arn) then SELECT from_arn. The CTE has to
      // model this as two branches; we do that by joining once and picking
      // the "other end" via CASE.
      joinClause = {
        select: "CASE WHEN e.from_arn = w.arn THEN e.to_arn ELSE e.from_arn END",
        joinOn: "",
        onExpr: "(e.from_arn = w.arn OR e.to_arn = w.arn)"
      };
      break;
    case "out":
    default:
      joinClause = {
        select: "e.to_arn",
        joinOn: "",
        onExpr: "e.from_arn = w.arn"
      };
      break;
  }

  return { joinClause, whereClause, extraParams };
}

function mapEdge(row: EdgeRow): Edge {
  return {
    fromArn: row.from_arn,
    toArn: row.to_arn,
    relationshipType: row.relationship_type,
    metadataJson: JSON.parse(row.metadata_json) as Record<string, unknown>,
    lastUpdated: row.last_updated
  };
}
