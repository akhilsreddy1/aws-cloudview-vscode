import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asyncDatabase, type Database } from "./sqliteAdapter";


export class SqliteDatabase {
  private inner?: DatabaseSync;
  private wrapped?: Database;

  /**
   * Opens (or creates) the SQLite database at `storagePath/cloud-view.sqlite`,
   * applies PRAGMAs, creates the schema tables if absent, runs migrations,
   * and returns the async-shaped adapter.
   *
   * Safe to call multiple times; `CREATE TABLE IF NOT EXISTS` is idempotent.
   */
  public async initialize(storagePath: string): Promise<Database> {
    await fs.mkdir(storagePath, { recursive: true });
    const filename = path.join(storagePath, "cloud-view.sqlite");

    this.inner = new DatabaseSync(filename);
    this.wrapped = asyncDatabase(this.inner);

    // PRAGMAs first — must run before CREATE TABLE for journal_mode=WAL to
    // take effect on the very first write. `node:sqlite` has no `pragma()`
    // helper; `exec()` runs and discards any returned rows, which is exactly
    // what we want here.
    this.inner.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -64000;
    `);

    this.inner.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        arn TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        service TEXT NOT NULL,
        account_id TEXT NOT NULL,
        region TEXT NOT NULL,
        name TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        last_updated INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resources_scope ON resources(account_id, region, service, type);
      CREATE INDEX IF NOT EXISTS idx_resources_search ON resources(name, type, id);

      CREATE TABLE IF NOT EXISTS edges (
        from_arn TEXT NOT NULL,
        to_arn TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        last_updated INTEGER NOT NULL,
        account_id TEXT,
        region TEXT,
        PRIMARY KEY (from_arn, to_arn, relationship_type)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_arn, relationship_type);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_arn);
      CREATE INDEX IF NOT EXISTS idx_edges_traverse_out ON edges(from_arn, relationship_type, to_arn, account_id);
      CREATE INDEX IF NOT EXISTS idx_edges_traverse_in ON edges(to_arn, relationship_type, from_arn);
      CREATE INDEX IF NOT EXISTS idx_edges_account ON edges(account_id);

      CREATE TABLE IF NOT EXISTS discovery_jobs (
        scope_key TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        region TEXT NOT NULL,
        service TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run INTEGER,
        next_eligible_run INTEGER,
        error TEXT,
        metadata_json TEXT NOT NULL,
        started_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        checkpoint_token TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_jobs_scope ON discovery_jobs(account_id, region, service, resource_type);
    `);

    await this.migrateDiscoveryJobs();
    await this.migrateEdges();

    return this.wrapped;
  }

  /**
   * Adds the `account_id` / `region` columns to the `edges` table on older
   * installs, then backfills them from the `resources` table.
   */
  private async migrateEdges(): Promise<void> {
    if (!this.inner) return;
    const cols = this.inner.prepare("PRAGMA table_info(edges)").all() as { name: string }[];
    const present = new Set(cols.map((c) => c.name));
    const needsAccountId = !present.has("account_id");
    const needsRegion = !present.has("region");

    if (needsAccountId) {
      this.inner.exec("ALTER TABLE edges ADD COLUMN account_id TEXT");
    }
    if (needsRegion) {
      this.inner.exec("ALTER TABLE edges ADD COLUMN region TEXT");
    }

    if (needsAccountId || needsRegion) {
      this.inner.exec(`
        UPDATE edges
        SET account_id = COALESCE(account_id, (SELECT account_id FROM resources WHERE arn = edges.from_arn)),
            region     = COALESCE(region,     (SELECT region     FROM resources WHERE arn = edges.from_arn))
        WHERE account_id IS NULL OR region IS NULL;
      `);
      this.inner.exec(`
        DROP INDEX IF EXISTS idx_edges_traverse_out;
        CREATE INDEX IF NOT EXISTS idx_edges_traverse_out ON edges(from_arn, relationship_type, to_arn, account_id);
        CREATE INDEX IF NOT EXISTS idx_edges_account ON edges(account_id);
      `);
    }
  }

  /**
   * Adds columns introduced after the initial schema so older databases
   * keep working after an extension upgrade.
   */
  private async migrateDiscoveryJobs(): Promise<void> {
    if (!this.inner) return;
    const cols = this.inner.prepare("PRAGMA table_info(discovery_jobs)").all() as { name: string }[];
    const present = new Set(cols.map((c) => c.name));
    if (!present.has("started_at")) {
      this.inner.exec("ALTER TABLE discovery_jobs ADD COLUMN started_at INTEGER");
    }
    if (!present.has("consecutive_failures")) {
      this.inner.exec("ALTER TABLE discovery_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    }
    if (!present.has("checkpoint_token")) {
      this.inner.exec("ALTER TABLE discovery_jobs ADD COLUMN checkpoint_token TEXT");
    }
  }

  public get connection(): Database {
    if (!this.wrapped) {
      throw new Error("SQLite database has not been initialized");
    }
    return this.wrapped;
  }

  /**
   * Deletes all rows from every table and runs `VACUUM` to reclaim disk space.
   * Used by the "Clear Database" command.
   */
  public async clearAll(): Promise<void> {
    if (!this.inner) return;
    this.inner.exec(`
      DELETE FROM resources;
      DELETE FROM edges;
      DELETE FROM discovery_jobs;
    `);
    this.inner.exec("VACUUM;");
  }

  public async close(): Promise<void> {
    this.inner?.close();
    this.inner = undefined;
    this.wrapped = undefined;
  }
}
