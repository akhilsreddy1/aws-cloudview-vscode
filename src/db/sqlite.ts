import * as fs from "node:fs/promises";
import * as path from "node:path";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";

/**
 * Thin wrapper around the `sqlite` / `sqlite3` packages that owns the
 * database lifecycle (open, schema migration, clear, close).
 *
 * The database file is stored in VS Code's `globalStorageUri` directory so
 * it persists across sessions but is isolated per extension installation.
 * WAL mode is enabled for better read/write concurrency.
 * Options to refresh and clear the database are provided.
 */
export class SqliteDatabase {
  private db?: Database;

  /**
   * Opens (or creates) the SQLite database at `storagePath/cloud-view.sqlite`,
   * creates the schema tables if they don't exist, and returns the connection.
   *
   * Safe to call multiple times; `CREATE TABLE IF NOT EXISTS` is idempotent.
   */
  public async initialize(storagePath: string): Promise<Database> {
    await fs.mkdir(storagePath, { recursive: true });
    const filename = path.join(storagePath, "cloud-view.sqlite");

    this.db = await open({
      filename,
      driver: sqlite3.Database
    });

    await this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -64000;
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

    return this.db;
  }

  /**
   * Adds the `account_id` / `region` columns to the `edges` table on older
   * installs, then backfills them from the `resources` table by joining on
   * `from_arn`. The columns are nullable so legacy rows from deleted resources
   * stay valid; traversal queries use `IS NULL` / `IN (?)` gracefully.
   */
  private async migrateEdges(): Promise<void> {
    if (!this.db) { return; }
    const cols = await this.db.all<{ name: string }[]>("PRAGMA table_info(edges)");
    const present = new Set(cols.map((c) => c.name));
    const needsAccountId = !present.has("account_id");
    const needsRegion = !present.has("region");

    if (needsAccountId) {
      await this.db.exec("ALTER TABLE edges ADD COLUMN account_id TEXT");
    }
    if (needsRegion) {
      await this.db.exec("ALTER TABLE edges ADD COLUMN region TEXT");
    }

    if (needsAccountId || needsRegion) {
      // Backfill from resources joined on from_arn. One-shot; subsequent
      // upserts populate these columns directly via EdgeRepo.upsertMany.
      await this.db.exec(`
        UPDATE edges
        SET account_id = COALESCE(account_id, (SELECT account_id FROM resources WHERE arn = edges.from_arn)),
            region     = COALESCE(region,     (SELECT region     FROM resources WHERE arn = edges.from_arn))
        WHERE account_id IS NULL OR region IS NULL;
      `);
      // Covering indexes may have been created against old schema; recreate to
      // include the new columns where applicable.
      await this.db.exec(`
        DROP INDEX IF EXISTS idx_edges_traverse_out;
        CREATE INDEX IF NOT EXISTS idx_edges_traverse_out ON edges(from_arn, relationship_type, to_arn, account_id);
        CREATE INDEX IF NOT EXISTS idx_edges_account ON edges(account_id);
      `);
    }
  }

  /**
   * Adds columns introduced after the initial schema so older databases
   * keep working after an extension upgrade. SQLite does not support
   * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we inspect PRAGMA
   * output and only add what's missing.
   */
  private async migrateDiscoveryJobs(): Promise<void> {
    if (!this.db) { return; }
    const cols = await this.db.all<{ name: string }[]>("PRAGMA table_info(discovery_jobs)");
    const present = new Set(cols.map((c) => c.name));
    const additions: string[] = [];
    if (!present.has("started_at")) {
      additions.push("ALTER TABLE discovery_jobs ADD COLUMN started_at INTEGER");
    }
    if (!present.has("consecutive_failures")) {
      additions.push("ALTER TABLE discovery_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    }
    if (!present.has("checkpoint_token")) {
      additions.push("ALTER TABLE discovery_jobs ADD COLUMN checkpoint_token TEXT");
    }
    for (const sql of additions) {
      await this.db.exec(sql);
    }
  }

  public get connection(): Database {
    if (!this.db) {
      throw new Error("SQLite database has not been initialized");
    }

    return this.db;
  }

  /**
   * Deletes all rows from every table and runs `VACUUM` to reclaim disk space.
   * Used by the "Clear Database" command.
   */
  public async clearAll(): Promise<void> {
    if (!this.db) { return; }
    await this.db.exec(`
      DELETE FROM resources;
      DELETE FROM edges;
      DELETE FROM discovery_jobs;
    `);
    await this.db.exec("VACUUM;");
  }

  public async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }
}
