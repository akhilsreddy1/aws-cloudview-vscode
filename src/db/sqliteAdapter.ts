import { DatabaseSync } from "node:sqlite";

/**
 * Async-shaped facade over Node.js's built-in {@link DatabaseSync} matching
 * the subset of the `sqlite` package's `Database` API that the rest of the
 * codebase uses.
 *
 * Using the built-in `node:sqlite` (Node 22.5+, GA in Node 24) keeps us out
 * of the native-prebuild lifecycle — no `better-sqlite3` rebuild dance, no
 * per-Electron ABI matrix, no per-platform `.vsix` artifacts.
 */
export interface AsyncDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastID: number }>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = unknown[]>(sql: string, params?: unknown[]): Promise<T>;
  close(): Promise<void>;
}

/**
 * Wrap a `node:sqlite` connection into the {@link AsyncDatabase} shape.
 *
 * `node:sqlite` is synchronous, so we wrap each call in `Promise.resolve` /
 * `Promise.reject`. The repos remain `async` / `await`-friendly without
 * needing a rewrite.
 *
 * `lastInsertRowid` and `changes` come back as `bigint` in `node:sqlite`;
 * we coerce to `number` because every column we use them with is a 32-bit
 * row id and downstream code expects plain numbers.
 */
export function asyncDatabase(db: DatabaseSync): AsyncDatabase {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...(params as never[]));
      return {
        changes: typeof info.changes === "bigint" ? Number(info.changes) : info.changes,
        lastID: typeof info.lastInsertRowid === "bigint"
          ? Number(info.lastInsertRowid)
          : info.lastInsertRowid,
      };
    },
    async get<T = unknown>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    async all<T = unknown[]>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T;
    },
    async close() {
      db.close();
    },
  };
}

export type Database = AsyncDatabase;
