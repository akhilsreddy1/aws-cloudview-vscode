import type { Database } from "sqlite";
import type { ResourceNode } from "../core/contracts";
import { runSerializedTxn } from "./txn";

/**
 * Filter for scoping resource queries to a specific account/region/service/type
 * combination. All fields except `accountId` and `region` are optional;
 * omitting them broadens the query.
 */
export interface ResourceScopeFilter {
  accountId: string;
  region: string;
  service?: string;
  type?: string;
}

interface ResourceRow {
  arn: string;
  id: string;
  type: string;
  service: string;
  account_id: string;
  region: string;
  name: string;
  tags_json: string;
  raw_json: string;
  last_updated: number;
}

/**
 * SQLite-backed repository for {@link ResourceNode} objects.
 * All writes use `INSERT OR REPLACE` (upsert) semantics keyed on `arn`.
 */
export class ResourceRepo {
  public constructor(private readonly db: Database) {}

  /**
   * Upserts a batch of resources inside a single serialized transaction for
   * speed and atomicity: either every row is persisted or none are. The
   * `runSerializedTxn` helper ensures concurrent callers (e.g. parallel
   * `refreshDefinition` runs via `Promise.allSettled`) queue behind each
   * other instead of colliding on the single SQLite connection.
   */
  public async upsertMany(resources: ResourceNode[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }

    await runSerializedTxn(this.db, async () => {
      for (const resource of resources) {
        await this.db.run(
          `
            INSERT INTO resources (arn, id, type, service, account_id, region, name, tags_json, raw_json, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(arn) DO UPDATE SET
              id = excluded.id,
              type = excluded.type,
              service = excluded.service,
              account_id = excluded.account_id,
              region = excluded.region,
              name = excluded.name,
              tags_json = excluded.tags_json,
              raw_json = excluded.raw_json,
              last_updated = excluded.last_updated
          `,
          [
            resource.arn,
            resource.id,
            resource.type,
            resource.service,
            resource.accountId,
            resource.region,
            resource.name,
            JSON.stringify(resource.tags),
            JSON.stringify(resource.rawJson),
            resource.lastUpdated
          ]
        );
      }
    });
  }

  /**
   * Tombstones stale resources: removes rows from the (accountId, region, type)
   * scope that aren't present in `keepArns`. Called at the end of a successful
   * discovery run so deleted AWS resources disappear from the cache.
   *
   * SQLite has a hard parameter limit (default 999). For large sets we chunk
   * the `NOT IN (...)` clause and use a temporary id table when necessary.
   */
  public async deleteMissingInScope(params: {
    accountId: string;
    region: string;
    type: string;
    keepArns: Iterable<string>;
  }): Promise<number> {
    const keep = params.keepArns instanceof Set ? params.keepArns : new Set(params.keepArns);

    if (keep.size === 0) {
      const result = await this.db.run(
        "DELETE FROM resources WHERE account_id = ? AND region = ? AND type = ?",
        [params.accountId, params.region, params.type]
      );
      return result.changes ?? 0;
    }

    // Use a temp table to sidestep SQLite's variable limit on huge keep-sets.
    // `runSerializedTxn` guarantees the temp-table rows we insert here are
    // not mixed with another caller's rows (the temp table is connection-scoped
    // and the whole sequence runs atomically).
    return runSerializedTxn(this.db, async () => {
      await this.db.run("CREATE TEMP TABLE IF NOT EXISTS _keep_arns (arn TEXT PRIMARY KEY)");
      await this.db.run("DELETE FROM _keep_arns");

      const CHUNK = 400;
      const arns = Array.from(keep);
      for (let i = 0; i < arns.length; i += CHUNK) {
        const slice = arns.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "(?)").join(", ");
        await this.db.run(`INSERT INTO _keep_arns (arn) VALUES ${placeholders}`, slice);
      }

      const result = await this.db.run(
        `
          DELETE FROM resources
          WHERE account_id = ?
            AND region = ?
            AND type = ?
            AND arn NOT IN (SELECT arn FROM _keep_arns)
        `,
        [params.accountId, params.region, params.type]
      );

      await this.db.run("DELETE FROM _keep_arns");
      return result.changes ?? 0;
    });
  }

  public async getByArn(arn: string): Promise<ResourceNode | undefined> {
    const row = await this.db.get<ResourceRow>("SELECT * FROM resources WHERE arn = ?", [arn]);
    return row ? this.mapRow(row) : undefined;
  }

  public async getByArns(arns: string[]): Promise<ResourceNode[]> {
    if (arns.length === 0) {
      return [];
    }

    const placeholders = arns.map(() => "?").join(", ");
    const rows = await this.db.all<ResourceRow[]>(`SELECT * FROM resources WHERE arn IN (${placeholders})`, arns);
    return rows.map((row) => this.mapRow(row));
  }

  /** Full-text search across name, id, ARN, and type fields. Case-insensitive. */
  public async search(query: string, limit = 50): Promise<ResourceNode[]> {
    const normalized = `%${query.toLowerCase()}%`;
    const rows = await this.db.all<ResourceRow[]>(
      `
        SELECT *
        FROM resources
        WHERE lower(name) LIKE ?
          OR lower(id) LIKE ?
          OR lower(arn) LIKE ?
          OR lower(type) LIKE ?
        ORDER BY last_updated DESC
        LIMIT ?
      `,
      [normalized, normalized, normalized, normalized, limit]
    );
    return rows.map((row) => this.mapRow(row));
  }

  public async listByScope(filter: ResourceScopeFilter): Promise<ResourceNode[]> {
    const clauses = ["account_id = ?", "region = ?"];
    const parameters: unknown[] = [filter.accountId, filter.region];

    if (filter.service) {
      clauses.push("service = ?");
      parameters.push(filter.service);
    }

    if (filter.type) {
      clauses.push("type = ?");
      parameters.push(filter.type);
    }

    const rows = await this.db.all<ResourceRow[]>(
      `
        SELECT *
        FROM resources
        WHERE ${clauses.join(" AND ")}
        ORDER BY lower(name), id
      `,
      parameters
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Query resources across multiple accounts and regions for a given service.
   * Used by aggregate (multi-scope) views.
   */
  public async listByMultiScope(params: {
    service: string;
    accountIds: string[];
    regions: string[];
  }): Promise<ResourceNode[]> {
    if (params.accountIds.length === 0 || params.regions.length === 0) {
      return [];
    }

    const accountPlaceholders = params.accountIds.map(() => "?").join(", ");
    const regionPlaceholders = params.regions.map(() => "?").join(", ");

    const rows = await this.db.all<ResourceRow[]>(
      `
        SELECT *
        FROM resources
        WHERE service = ?
          AND account_id IN (${accountPlaceholders})
          AND region IN (${regionPlaceholders})
        ORDER BY account_id, region, lower(name), id
      `,
      [params.service, ...params.accountIds, ...params.regions]
    );
    return rows.map((row) => this.mapRow(row));
  }

  public async listByAccount(accountId: string, services?: string[]): Promise<ResourceNode[]> {
    return this.listByAccounts([accountId], services);
  }

  public async listByAccounts(accountIds: string[], services?: string[]): Promise<ResourceNode[]> {
    if (accountIds.length === 0) return [];

    const clauses: string[] = [];
    const parameters: unknown[] = [];

    const accountPlaceholders = accountIds.map(() => "?").join(", ");
    clauses.push(`account_id IN (${accountPlaceholders})`);
    parameters.push(...accountIds);

    if (services && services.length > 0) {
      const placeholders = services.map(() => "?").join(", ");
      clauses.push(`service IN (${placeholders})`);
      parameters.push(...services);
    }

    const rows = await this.db.all<ResourceRow[]>(
      `
        SELECT *
        FROM resources
        WHERE ${clauses.join(" AND ")}
        ORDER BY service, lower(name), id
      `,
      parameters
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Returns `true` if `resource.lastUpdated` is older than `ttlSeconds`.
   * Used by the graph engine to decide whether to re-discover a resource
   * before expanding it.
   */
  public isStale(resource: ResourceNode, ttlSeconds: number): boolean {
    return resource.lastUpdated + ttlSeconds * 1000 < Date.now();
  }

  private mapRow(row: ResourceRow): ResourceNode {
    return {
      arn: row.arn,
      id: row.id,
      type: row.type,
      service: row.service,
      accountId: row.account_id,
      region: row.region,
      name: row.name,
      tags: JSON.parse(row.tags_json) as Record<string, string>,
      rawJson: JSON.parse(row.raw_json) as Record<string, unknown>,
      lastUpdated: row.last_updated
    };
  }
}
