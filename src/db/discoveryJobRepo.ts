import type { Database } from "sqlite";
import type { DiscoveryJob } from "../core/contracts";

interface DiscoveryJobRow {
  scope_key: string;
  job_type: DiscoveryJob["jobType"];
  profile_name: string;
  account_id: string;
  region: string;
  service: string;
  resource_type: string;
  status: DiscoveryJob["status"];
  last_run?: number;
  next_eligible_run?: number;
  error?: string;
  metadata_json: string;
  started_at?: number | null;
  consecutive_failures?: number;
  checkpoint_token?: string | null;
}

/**
 * A `running` row older than this is considered abandoned (extension host
 * crashed, reload while discovery was in flight, …). Subsequent `shouldRun`
 * calls will return `true` so the job can be retried.
 */
const STALE_RUNNING_MS = 10 * 60 * 1_000;

const FAILURE_BASE_MS = 30 * 1_000;
const FAILURE_MAX_MS = 30 * 60 * 1_000;

/**
 * Repository for the `discovery_jobs` table that tracks per-scope
 * discovery lifecycle: eligibility, running locks with stale-detection,
 * consecutive-failure backoff, and resumable pagination checkpoints.
 */
export class DiscoveryJobRepo {
  public constructor(private readonly db: Database) {}

  public async shouldRun(scopeKey: string, _ttlSeconds: number, force: boolean): Promise<boolean> {
    if (force) {
      return true;
    }

    const row = await this.db.get<DiscoveryJobRow>("SELECT * FROM discovery_jobs WHERE scope_key = ?", [scopeKey]);
    if (!row) {
      return true;
    }

    const now = Date.now();

    // Abandoned `running` lock — treat as eligible so we recover automatically.
    if (row.status === "running" && typeof row.started_at === "number" && now - row.started_at > STALE_RUNNING_MS) {
      return true;
    }

    if (!row.next_eligible_run) {
      // Edge case: row exists but never reached a terminal state; allow a run.
      return row.status !== "running";
    }

    return row.next_eligible_run <= now;
  }

  public async markRunning(job: DiscoveryJob): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `
        INSERT INTO discovery_jobs (
          scope_key, job_type, profile_name, account_id, region, service, resource_type, status, metadata_json, started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          job_type = excluded.job_type,
          profile_name = excluded.profile_name,
          account_id = excluded.account_id,
          region = excluded.region,
          service = excluded.service,
          resource_type = excluded.resource_type,
          status = excluded.status,
          error = NULL,
          metadata_json = excluded.metadata_json,
          started_at = excluded.started_at
      `,
      [
        job.scopeKey,
        job.jobType,
        job.profileName,
        job.accountId,
        job.region,
        job.service,
        job.resourceType,
        job.status,
        JSON.stringify(job.metadataJson),
        now
      ]
    );
  }

  public async markSuccess(scopeKey: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `
        UPDATE discovery_jobs
        SET status = 'succeeded',
            last_run = ?,
            next_eligible_run = ?,
            error = NULL,
            started_at = NULL,
            consecutive_failures = 0,
            checkpoint_token = NULL
        WHERE scope_key = ?
      `,
      [now, now + ttlSeconds * 1000, scopeKey]
    );
  }

  /**
   * Records a failure and schedules an exponential-backoff retry
   * (30s, 1m, 2m, 4m, … capped at 30m). The `checkpoint_token` is
   * preserved so a subsequent run can resume from where it stopped.
   */
  public async markFailure(scopeKey: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const prev = await this.db.get<{ consecutive_failures?: number }>(
      "SELECT consecutive_failures FROM discovery_jobs WHERE scope_key = ?",
      [scopeKey]
    );
    const nextFails = (prev?.consecutive_failures ?? 0) + 1;
    const cooldownMs = Math.min(FAILURE_BASE_MS * 2 ** (nextFails - 1), FAILURE_MAX_MS);

    await this.db.run(
      `
        UPDATE discovery_jobs
        SET status = 'failed',
            error = ?,
            started_at = NULL,
            consecutive_failures = ?,
            next_eligible_run = ?
        WHERE scope_key = ?
      `,
      [message, nextFails, Date.now() + cooldownMs, scopeKey]
    );
  }

  /** Persist the pagination token for a running job so it can resume after a crash or restart. */
  public async saveCheckpoint(scopeKey: string, token: string | undefined): Promise<void> {
    await this.db.run(
      "UPDATE discovery_jobs SET checkpoint_token = ? WHERE scope_key = ?",
      [token ?? null, scopeKey]
    );
  }

  public async getCheckpoint(scopeKey: string): Promise<string | undefined> {
    const row = await this.db.get<{ checkpoint_token?: string | null }>(
      "SELECT checkpoint_token FROM discovery_jobs WHERE scope_key = ?",
      [scopeKey]
    );
    return row?.checkpoint_token ?? undefined;
  }

  public async getConsecutiveFailures(scopeKey: string): Promise<number> {
    const row = await this.db.get<{ consecutive_failures?: number }>(
      "SELECT consecutive_failures FROM discovery_jobs WHERE scope_key = ?",
      [scopeKey]
    );
    return row?.consecutive_failures ?? 0;
  }
}
