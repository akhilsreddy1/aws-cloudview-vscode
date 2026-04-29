import * as vscode from "vscode";
import {
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
  ListWorkGroupsCommand,
  ListDatabasesCommand,
  ListTableMetadataCommand,
  type Datum,
  type Row,
} from "@aws-sdk/client-athena";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsProfileSession } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";
import { readCloudViewConfiguration } from "../core/config";

interface PanelScope {
  session: AwsProfileSession;
  region: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_INTERVAL_MS = 5000;
const RESULT_PAGE_LIMIT = 1000;     // Athena max per page
const RESULT_PAGE_FETCH_MAX = 5;    // 5,000 rows in the panel before "(more available)"

/** Tables list freshness window — re-fetch after this. Tunes "second open in same session" UX. */
const TABLES_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedTables {
  entries: Array<{ database: string; name: string; tableType?: string }>;
  truncated: boolean;
  fetchedAt: number;
}

/**
 * Process-wide tables cache keyed by `profile|account|region|catalog`. Survives
 * panel close/reopen for the lifetime of the VS Code session, so the second
 * `Athena (Query)` click is instant. Invalidated by the dropdown's ↻ button or
 * by the TTL above.
 */
const tablesCache = new Map<string, CachedTables>();
function tablesCacheKey(profileName: string, accountId: string, region: string, catalog: string): string {
  return `${profileName}|${accountId}|${region}|${catalog}`;
}

/**
 * Athena Query Runner — a webview that runs read SQL against AWS Athena and
 * streams results into a table. Workgroup + database pickers are populated
 * from the user's account; the query editor is a plain textarea (no syntax
 * highlighting yet — that's a v2 enhancement). Cancel hits
 * `StopQueryExecution` for the in-flight execution id.
 *
 * Output location is taken from the chosen workgroup's configuration. If the
 * workgroup has no default location, the panel surfaces Athena's own error
 * message rather than guessing an S3 path.
 */
export class AthenaQueryPanel {
  private static panels = new Map<string, AthenaQueryPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly key: string;

  /** Currently-running query execution id, or undefined if idle. */
  private runningExecutionId?: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private scope: PanelScope,
  ) {
    this.key = `${scope.session.profileName}|${scope.session.accountId}|${scope.region}`;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewAthenaQuery",
      `Athena: ${scope.session.profileName} · ${scope.region}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      AthenaQueryPanel.panels.delete(this.key);
      // Best-effort: cancel any in-flight query when the panel closes.
      if (this.runningExecutionId) void this.cancelExecution(this.runningExecutionId);
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          await this.bootstrap();
        } else if (msg.type === "refreshTables") {
          await this.bootstrap({ force: true });
        } else if (msg.type === "runQuery") {
          await this.runQuery(
            String(msg.sql ?? ""),
            String(msg.workgroup ?? "primary"),
            typeof msg.database === "string" && msg.database.length > 0 ? msg.database : undefined,
          );
        } else if (msg.type === "cancelQuery" && this.runningExecutionId) {
          await this.cancelExecution(this.runningExecutionId);
        } else if (msg.type === "changeRegion" && typeof msg.region === "string") {
          await this.changeRegion(msg.region);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  /** Open the panel, prompting for profile + region if not already chosen. */
  public static async open(platform: CloudViewPlatform): Promise<void> {
    const sessions = await platform.sessionManager.getSelectedProfileSessions();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage("Select an AWS profile first (CloudView: Select AWS Profiles).");
      return;
    }

    let session = sessions[0];
    if (sessions.length > 1) {
      const picked = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.profileName, description: s.accountId, _session: s })),
        { title: "Athena: pick a profile", placeHolder: "Profile to run queries against" },
      );
      if (!picked) return;
      session = picked._session;
    }

    const cfg = readCloudViewConfiguration();
    const realRegions = cfg.regions.filter((r) => r !== "global");
    let region = session.defaultRegion ?? realRegions[0] ?? "us-east-1";
    if (realRegions.length > 1) {
      const picked = await vscode.window.showQuickPick(realRegions, {
        title: "Athena: pick a region",
        placeHolder: "Region for Athena queries",
      });
      if (!picked) return;
      region = picked;
    }

    const key = `${session.profileName}|${session.accountId}|${region}`;
    const existing = AthenaQueryPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new AthenaQueryPanel(platform, { session, region });
    AthenaQueryPanel.panels.set(key, instance);
  }

  // ─── Bootstrap (workgroups + databases) ────────────────────────────────────

  /**
   * Populate workgroups + tables. Workgroups are cheap (single API call),
   * always re-fetched. Tables are cached per-scope so the second panel open
   * in the same VS Code session is instant. Pass `force: true` (e.g. from
   * the toolbar refresh button) to bypass the cache.
   */
  private async bootstrap(opts: { force?: boolean } = {}): Promise<void> {
    const catalog = "AwsDataCatalog";
    const cacheKey = tablesCacheKey(
      this.scope.session.profileName,
      this.scope.session.accountId,
      this.scope.region,
      catalog,
    );

    // Check cache for tables before kicking off the expensive fan-out.
    const cached = tablesCache.get(cacheKey);
    const cacheFresh = !!cached && Date.now() - cached.fetchedAt < TABLES_CACHE_TTL_MS;
    const useCache = !opts.force && cacheFresh;

    const [workgroups, tables] = await Promise.all([
      this.listWorkgroups().catch((err) => {
        this.postError(`ListWorkGroups failed: ${err instanceof Error ? err.message : String(err)}`);
        return [] as string[];
      }),
      useCache
        ? Promise.resolve({ entries: cached!.entries, truncated: cached!.truncated })
        : this.listTablesAndViews(catalog)
            .then((result) => {
              tablesCache.set(cacheKey, { ...result, fetchedAt: Date.now() });
              return result;
            })
            .catch((err) => {
              this.postError(`Listing tables failed: ${err instanceof Error ? err.message : String(err)}`);
              return { entries: [], truncated: false };
            }),
    ]);

    void this.panel.webview.postMessage({
      type: "bootstrap",
      workgroups,
      tables: tables.entries,
      tablesTruncated: tables.truncated,
      tablesFromCache: useCache,
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
      regions: readCloudViewConfiguration().regions.filter((r) => r !== "global"),
    });
  }

  private async listWorkgroups(): Promise<string[]> {
    const client = await this.platform.awsClientFactory.athena({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });
    const out: string[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await this.platform.scheduler.run("athena", "ListWorkGroups", () =>
        client.send(new ListWorkGroupsCommand({ NextToken: nextToken, MaxResults: 50 }))
      );
      for (const wg of resp.WorkGroups ?? []) {
        if (wg.Name && wg.State !== "DISABLED") out.push(wg.Name);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    out.sort();
    // Ensure "primary" is selectable even if not surfaced (it always exists).
    if (!out.includes("primary")) out.unshift("primary");
    return out;
  }

  /**
   * Enumerate all `(database, table)` pairs across the catalog. Two-phase:
   * (1) `ListDatabases` to get all databases (capped at MAX_DATABASES),
   * (2) `ListTableMetadata` per database in parallel batches (cap concurrency
   * to avoid AWS throttling). Results are flattened to `db.table` entries
   * sorted alphabetically. If we hit the MAX_TOTAL_TABLES safety cap, the
   * `truncated` flag tells the UI to show a "+ N more" hint.
   */
  private async listTablesAndViews(catalogName: string): Promise<{
    entries: Array<{ database: string; name: string; tableType?: string }>;
    truncated: boolean;
  }> {
    const MAX_DATABASES = 100;
    const MAX_TOTAL_TABLES = 500;
    const PARALLEL_DB_FETCHES = 5;

    const client = await this.platform.awsClientFactory.athena({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });

    // Phase 1: enumerate databases.
    const databases: string[] = [];
    {
      let nextToken: string | undefined;
      do {
        const resp = await this.platform.scheduler.run("athena", "ListDatabases", () =>
          client.send(new ListDatabasesCommand({
            CatalogName: catalogName,
            NextToken: nextToken,
            MaxResults: 50,
          }))
        );
        for (const db of resp.DatabaseList ?? []) {
          if (db.Name) databases.push(db.Name);
          if (databases.length >= MAX_DATABASES) break;
        }
        nextToken = resp.NextToken;
        if (databases.length >= MAX_DATABASES) break;
      } while (nextToken);
    }
    databases.sort();

    // Phase 2: fan out ListTableMetadata across databases. Concurrency is
    // capped because the per-service scheduler may already serialize
    // catalog-style calls; this still parallelises across distinct databases.
    const entries: Array<{ database: string; name: string; tableType?: string }> = [];
    let truncated = false;
    for (let i = 0; i < databases.length; i += PARALLEL_DB_FETCHES) {
      const slice = databases.slice(i, i + PARALLEL_DB_FETCHES);
      const results = await Promise.all(
        slice.map((dbName) => this.fetchTablesForDatabase(client, catalogName, dbName))
      );
      for (let j = 0; j < results.length; j++) {
        const dbName = slice[j];
        for (const t of results[j]) {
          entries.push({ database: dbName, name: t.name, tableType: t.tableType });
          if (entries.length >= MAX_TOTAL_TABLES) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }

    entries.sort((a, b) => {
      const dbCmp = a.database.localeCompare(b.database);
      return dbCmp !== 0 ? dbCmp : a.name.localeCompare(b.name);
    });
    return { entries, truncated };
  }

  /**
   * Fetch all table/view metadata for one database, paginated. Returns up to
   * 200 entries per database (4 pages × 50) — beyond that is unusable in a
   * dropdown. Failures (permissions, missing catalog) are swallowed per-db so
   * one broken db doesn't block the rest.
   */
  private async fetchTablesForDatabase(
    client: import("@aws-sdk/client-athena").AthenaClient,
    catalogName: string,
    databaseName: string,
  ): Promise<Array<{ name: string; tableType?: string }>> {
    const out: Array<{ name: string; tableType?: string }> = [];
    let nextToken: string | undefined;
    let pages = 0;
    try {
      do {
        const resp = await this.platform.scheduler.run("athena", "ListTableMetadata", () =>
          client.send(new ListTableMetadataCommand({
            CatalogName: catalogName,
            DatabaseName: databaseName,
            NextToken: nextToken,
            MaxResults: 50,
          }))
        );
        for (const tm of resp.TableMetadataList ?? []) {
          if (tm.Name) out.push({ name: tm.Name, tableType: tm.TableType });
        }
        nextToken = resp.NextToken;
        pages += 1;
        if (pages >= 4) break; // 200-table cap per database
      } while (nextToken);
    } catch (err) {
      this.platform.logger.warn(
        `ListTableMetadata failed for ${databaseName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return out;
  }

  // ─── Query execution ──────────────────────────────────────────────────────

  private async runQuery(sql: string, workgroup: string, database?: string): Promise<void> {
    if (!sql.trim()) {
      this.postError("SQL is empty.");
      return;
    }
    if (this.runningExecutionId) {
      this.postError("A query is already running. Cancel it first.");
      return;
    }

    const client = await this.platform.awsClientFactory.athena({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });

    let executionId: string;
    try {
      const startResp = await this.platform.scheduler.run("athena", "StartQueryExecution", () =>
        client.send(new StartQueryExecutionCommand({
          QueryString: sql,
          WorkGroup: workgroup,
          QueryExecutionContext: database ? { Database: database } : undefined,
          // We deliberately don't pass `ResultConfiguration`. Athena requires
          // a result location, but a CLI-style extension shouldn't manage S3
          // buckets — that's a one-time setup the user does in the console.
          // If the chosen workgroup has no location configured, surface a
          // clear, actionable error pointing them at the right setting.
        }))
      );
      executionId = startResp.QueryExecutionId ?? "";
      if (!executionId) throw new Error("Athena did not return a query execution id");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isOutputLocationErr = /OutputLocation|output location|result configuration/i.test(msg);
      const friendly = isOutputLocationErr
        ? `This workgroup ("${workgroup}") has no query-result location configured.\n\n` +
          `Fix it once in the AWS Console:\n` +
          `  1. Athena → Workgroups → "${workgroup}" → Edit\n` +
          `  2. Set "Query result location" to an S3 path you own, e.g.\n` +
          `     s3://aws-athena-query-results-${this.scope.session.accountId}-${this.scope.region}/\n` +
          `  3. Save, then click Run again here.\n\n` +
          `Or pick a different workgroup that already has one set.`
        : msg;
      this.postError(`StartQueryExecution failed: ${friendly}`);
      return;
    }

    this.runningExecutionId = executionId;
    void this.panel.webview.postMessage({ type: "queryStarted", executionId });

    // Poll until terminal state.
    let interval = POLL_INTERVAL_MS;
    let state = "QUEUED";
    let stateChangeReason: string | undefined;
    let stats: { dataScannedBytes?: number; runtimeMs?: number } = {};
    while (true) {
      await new Promise((r) => setTimeout(r, interval));
      // The user (or panel disposal) cancelled while we were sleeping.
      if (this.runningExecutionId !== executionId) {
        return;
      }
      let qe;
      try {
        qe = await this.platform.scheduler.run("athena", "GetQueryExecution", () =>
          client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }))
        );
      } catch (err: unknown) {
        this.runningExecutionId = undefined;
        this.postError(`GetQueryExecution failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const newState = qe.QueryExecution?.Status?.State ?? state;
      stateChangeReason = qe.QueryExecution?.Status?.StateChangeReason;
      stats = {
        dataScannedBytes: qe.QueryExecution?.Statistics?.DataScannedInBytes,
        runtimeMs: qe.QueryExecution?.Statistics?.TotalExecutionTimeInMillis,
      };
      if (newState !== state) {
        state = newState;
        void this.panel.webview.postMessage({ type: "queryState", executionId, state, stats });
      }
      if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED") {
        break;
      }
      interval = Math.min(POLL_MAX_INTERVAL_MS, Math.floor(interval * 1.25));
    }

    if (state !== "SUCCEEDED") {
      this.runningExecutionId = undefined;
      void this.panel.webview.postMessage({
        type: "queryFinished",
        executionId,
        state,
        stats,
        error: stateChangeReason ?? state,
      });
      return;
    }

    // Stream results, up to RESULT_PAGE_FETCH_MAX pages.
    let columns: string[] = [];
    const rows: string[][] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let truncated = false;
    while (pages < RESULT_PAGE_FETCH_MAX) {
      let qr;
      try {
        qr = await this.platform.scheduler.run("athena", "GetQueryResults", () =>
          client.send(new GetQueryResultsCommand({
            QueryExecutionId: executionId,
            MaxResults: RESULT_PAGE_LIMIT,
            NextToken: nextToken,
          }))
        );
      } catch (err: unknown) {
        this.postError(`GetQueryResults failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      // Column metadata only available on first page; the first row is the
      // header row when the engine returns scalar SELECTs, so skip it.
      if (pages === 0) {
        columns = (qr.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [])
          .map((c) => c.Name ?? "");
      }
      const pageRows = qr.ResultSet?.Rows ?? [];
      const start = pages === 0 ? 1 : 0;   // first row of first page is header echo
      for (let i = start; i < pageRows.length; i++) {
        rows.push(rowToValues(pageRows[i], columns.length));
      }
      nextToken = qr.NextToken;
      pages += 1;
      if (!nextToken) break;
    }
    if (nextToken) truncated = true;

    this.runningExecutionId = undefined;
    void this.panel.webview.postMessage({
      type: "queryFinished",
      executionId,
      state: "SUCCEEDED",
      stats,
      columns,
      rows,
      truncated,
    });
  }

  private async cancelExecution(executionId: string): Promise<void> {
    const client = await this.platform.awsClientFactory.athena({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });
    try {
      await this.platform.scheduler.run("athena", "StopQueryExecution", () =>
        client.send(new StopQueryExecutionCommand({ QueryExecutionId: executionId }))
      );
    } catch {
      // best-effort; the poll loop will see the terminal state regardless
    }
    if (this.runningExecutionId === executionId) {
      this.runningExecutionId = undefined;
    }
    void this.panel.webview.postMessage({ type: "queryCancelled", executionId });
  }

  private async changeRegion(region: string): Promise<void> {
    if (region === this.scope.region) return;
    this.scope = { ...this.scope, region };
    this.panel.title = `Athena: ${this.scope.session.profileName} · ${region}`;
    await this.bootstrap();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Athena Query Runner</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .ath-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .ath-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .ath-title .icon { color: #232F3E; font-size: 20px; }
    .ath-meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .ath-meta .label { font-weight: 600; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar select, .toolbar input {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .btn {
      background: var(--accent); color: white; border: none;
      padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.danger { background: #C7131F; }
    .btn.danger:hover { background: #a2101a; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }

    .editor-wrap { padding: 10px 20px 0; flex-shrink: 0; }
    textarea#sql {
      width: 100%; min-height: 140px; max-height: 260px; resize: vertical;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 10px 12px; border-radius: var(--radius); font-size: 13px;
      font-family: 'SF Mono', 'Fira Code', Menlo, monospace; line-height: 1.5;
      tab-size: 2;
    }
    .run-row { display: flex; gap: 8px; align-items: center; padding: 8px 20px 12px; flex-shrink: 0; }

    .summary-row { padding: 8px 20px; font-size: 11px; color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; gap: 16px; flex-wrap: wrap; }
    .summary-row strong { color: var(--text-2); font-weight: 600; }
    .state-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
    .state-QUEUED { background: #e0e7ff; color: #3730a3; }
    .state-RUNNING { background: #fef3c7; color: #92400e; }
    .state-SUCCEEDED { background: #dcfce7; color: #166534; }
    .state-FAILED, .state-CANCELLED { background: #fee2e2; color: #991b1b; }

    .content { flex: 1; overflow: auto; background: var(--surface); position: relative; }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    table.results {
      border-collapse: collapse; font-size: 12px; width: 100%; min-width: max-content;
      font-family: 'SF Mono', 'Fira Code', Menlo, monospace;
    }
    table.results thead th {
      background: var(--surface-2); position: sticky; top: 0; z-index: 1;
      border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left;
      font-weight: 700; color: var(--text); white-space: nowrap;
    }
    table.results tbody td {
      padding: 4px 10px; border-bottom: 1px solid var(--border);
      max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text);
    }
    table.results tbody tr:hover td { background: var(--surface-2); }

    .truncated-banner { padding: 8px 20px; font-size: 11px; background: #fef3c7; color: #92400e; border-top: 1px solid #fde68a; }

    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none; white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="ath-header">
    <div class="ath-title">
      <span class="icon">\u{1F50E}</span>
      <span>Athena Query Runner</span>
    </div>
    <div class="ath-meta">
      <span><span class="label">Profile:</span> <span id="hdr-profile">…</span></span>
      <span><span class="label">Account:</span> <span id="hdr-account">…</span></span>
      <span><span class="label">Region:</span>
        <select id="region-select" style="margin-left:4px;font-size:11px;padding:2px 6px;">
          <option>…</option>
        </select>
      </span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <label>Workgroup</label>
    <select id="workgroup"><option>…</option></select>
    <label style="margin-left:8px;">Tables / Views</label>
    <select id="table" style="min-width:280px;"><option value="">Loading tables… (this can take a few seconds)</option></select>
    <button class="btn ghost" id="refresh-tables" title="Re-fetch databases &amp; tables from Glue. Pick this after you create a new table you don't see here." style="font-size:11px;padding:4px 8px;">↻</button>
    <span id="tables-truncated" style="display:none;font-size:10px;color:#92400e;background:#fef3c7;padding:2px 8px;border-radius:10px;" title="Some tables omitted to keep the dropdown responsive — write fully-qualified names manually if needed.">+ more available</span>
    <span id="tables-cache-hint" style="display:none;font-size:10px;color:var(--muted);" title="Tables list came from in-memory cache (refreshed every 5 min, or on demand via the ↻ button)."></span>
  </div>

  <div class="editor-wrap">
    <textarea id="sql" spellcheck="false" placeholder="SELECT * FROM &quot;your_database&quot;.&quot;your_table&quot; LIMIT 100"></textarea>
  </div>
  <div class="run-row">
    <button class="btn" id="run-btn">▶ Run query</button>
    <button class="btn danger" id="cancel-btn" style="display:none;">⏹ Cancel</button>
    <span style="flex:1;"></span>
    <span id="status" style="font-size:11px;color:var(--muted);"></span>
  </div>

  <div class="summary-row" id="summary" style="display:none;"></div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F50E}</div>
      <div>Write a SELECT and hit <strong>Run query</strong>.</div>
      <div style="font-size:11px;margin-top:6px;">Athena bills per byte scanned. Use partition filters and LIMIT clauses.</div>
    </div>
    <div id="results-wrap" style="display:none;overflow:auto;max-height:100%;">
      <table class="results" id="results">
        <thead><tr id="results-head"></tr></thead>
        <tbody id="results-body"></tbody>
      </table>
      <div class="truncated-banner" id="truncated" style="display:none;"></div>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var hdrProfile = document.getElementById('hdr-profile');
    var hdrAccount = document.getElementById('hdr-account');
    var regionSelect = document.getElementById('region-select');
    var wgSelect = document.getElementById('workgroup');
    var tableSelect = document.getElementById('table');
    var refreshTablesBtn = document.getElementById('refresh-tables');
    var tablesTruncated = document.getElementById('tables-truncated');
    var tablesCacheHint = document.getElementById('tables-cache-hint');
    var sqlInput = document.getElementById('sql');
    // Currently-selected (database, tableName) pair derived from the table dropdown.
    var selectedDatabase = '';
    var runBtn = document.getElementById('run-btn');
    var cancelBtn = document.getElementById('cancel-btn');
    var statusEl = document.getElementById('status');
    var summary = document.getElementById('summary');
    var emptyEl = document.getElementById('empty');
    var resultsWrap = document.getElementById('results-wrap');
    var resultsHead = document.getElementById('results-head');
    var resultsBody = document.getElementById('results-body');
    var truncatedEl = document.getElementById('truncated');
    var errorBanner = document.getElementById('error-banner');

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
    }
    function clearError() { errorBanner.style.display = 'none'; }

    function fmtBytes(n) {
      if (!n || !isFinite(n)) return '0 B';
      var u = ['B','KB','MB','GB','TB']; var i = Math.floor(Math.log(n) / Math.log(1024));
      return (n / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
    }
    function fmtMs(n) {
      if (!n || !isFinite(n)) return '0 ms';
      if (n < 1000) return n + ' ms';
      return (n / 1000).toFixed(2) + ' s';
    }

    runBtn.onclick = function() {
      clearError();
      vscode.postMessage({
        type: 'runQuery',
        sql: sqlInput.value,
        workgroup: wgSelect.value,
        // selectedDatabase comes from the chosen table; if no table picked,
        // user can still write fully-qualified names like "db"."table".
        database: selectedDatabase || undefined,
      });
      runBtn.style.display = 'none';
      cancelBtn.style.display = '';
      statusEl.textContent = 'Submitting…';
      summary.innerHTML = '';
      summary.style.display = 'none';
      emptyEl.style.display = 'flex';
      resultsWrap.style.display = 'none';
    };
    cancelBtn.onclick = function() {
      vscode.postMessage({ type: 'cancelQuery' });
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
    };
    regionSelect.onchange = function() {
      vscode.postMessage({ type: 'changeRegion', region: regionSelect.value });
    };

    // Manual cache invalidation. Resets the dropdown to its loading state so
    // the user sees the operation register, then asks the backend to bypass
    // the in-memory cache for the current scope.
    refreshTablesBtn.onclick = function() {
      tableSelect.innerHTML = '<option value="">Loading tables… (this can take a few seconds)</option>';
      tablesCacheHint.style.display = 'none';
      tablesTruncated.style.display = 'none';
      refreshTablesBtn.disabled = true;
      refreshTablesBtn.textContent = '…';
      vscode.postMessage({ type: 'refreshTables' });
    };

    // Selecting a table: parse "db.table" out of the option value, set the
    // running database context, and insert a starter query into the editor —
    // but only if the editor is empty (don't clobber the user's WIP).
    tableSelect.onchange = function() {
      var v = tableSelect.value;
      if (!v) { selectedDatabase = ''; return; }
      var parts = v.split('\\u0001'); // we encode db, table separated by U+0001 to avoid name collisions with dots
      if (parts.length < 2) return;
      selectedDatabase = parts[0];
      var tableName = parts[1];
      var snippet = 'SELECT *\\nFROM "' + selectedDatabase + '"."' + tableName + '"\\nLIMIT 100;';
      if (!sqlInput.value.trim()) {
        sqlInput.value = snippet;
      } else {
        // Insert just the qualified table reference at cursor — non-destructive.
        var ref = '"' + selectedDatabase + '"."' + tableName + '"';
        var start = sqlInput.selectionStart;
        var end = sqlInput.selectionEnd;
        sqlInput.value = sqlInput.value.slice(0, start) + ref + sqlInput.value.slice(end);
        sqlInput.selectionStart = sqlInput.selectionEnd = start + ref.length;
      }
      sqlInput.focus();
    };

    function renderState(state, stats) {
      var bits = ['<span class="state-badge state-' + esc(state) + '">' + esc(state) + '</span>'];
      if (stats && stats.runtimeMs) bits.push('runtime: <strong>' + fmtMs(stats.runtimeMs) + '</strong>');
      if (stats && stats.dataScannedBytes != null) bits.push('scanned: <strong>' + fmtBytes(stats.dataScannedBytes) + '</strong>');
      summary.innerHTML = bits.join(' · ');
      summary.style.display = 'flex';
    }

    function renderResults(columns, rows, truncated) {
      emptyEl.style.display = 'none';
      resultsWrap.style.display = '';
      resultsHead.innerHTML = (columns || []).map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('');
      resultsBody.innerHTML = (rows || []).map(function(r) {
        return '<tr>' + r.map(function(v) { return '<td title="' + esc(v) + '">' + esc(v) + '</td>'; }).join('') + '</tr>';
      }).join('');
      if (truncated) {
        truncatedEl.textContent = 'Showing first ' + (rows ? rows.length : 0) + ' rows. More rows available — refine your query or download via the Athena console.';
        truncatedEl.style.display = '';
      } else {
        truncatedEl.style.display = 'none';
      }
    }

    function endRunning() {
      runBtn.style.display = '';
      cancelBtn.style.display = 'none';
      cancelBtn.disabled = false;
      cancelBtn.textContent = '⏹ Cancel';
      statusEl.textContent = '';
    }

    window.addEventListener('message', function(ev) {
      var m = ev.data;
      if (m.type === 'bootstrap') {
        hdrProfile.textContent = m.profileName;
        hdrAccount.textContent = m.accountId;
        regionSelect.innerHTML = (m.regions || []).map(function(r) {
          return '<option value="' + esc(r) + '"' + (r === m.region ? ' selected' : '') + '>' + esc(r) + '</option>';
        }).join('');
        wgSelect.innerHTML = (m.workgroups || []).map(function(w) {
          return '<option value="' + esc(w) + '"' + (w === 'primary' ? ' selected' : '') + '>' + esc(w) + '</option>';
        }).join('');
        var tables = m.tables || [];
        var opts = '<option value="">(pick to insert into editor)</option>';
        for (var i = 0; i < tables.length; i++) {
          var t = tables[i];
          // Encode db + name with U+0001 so dots inside names don't break the parser.
          var val = t.database + '\\u0001' + t.name;
          var typeSuffix = t.tableType === 'VIRTUAL_VIEW' ? ' (view)'
                         : t.tableType === 'EXTERNAL_TABLE' ? ''
                         : (t.tableType ? ' (' + esc(t.tableType.toLowerCase()) + ')' : '');
          opts += '<option value="' + esc(val) + '">' + esc(t.database) + '.' + esc(t.name) + typeSuffix + '</option>';
        }
        tableSelect.innerHTML = opts;
        selectedDatabase = '';
        tablesTruncated.style.display = m.tablesTruncated ? '' : 'none';
        // Reset the refresh button regardless of whether this bootstrap was
        // triggered by it — handles the "ready" path too.
        refreshTablesBtn.disabled = false;
        refreshTablesBtn.textContent = '↻';
        // Subtle hint when the dropdown was served from cache. Doesn't block
        // anything; just helps explain why a brand-new table isn't showing.
        if (m.tablesFromCache) {
          tablesCacheHint.textContent = 'cached · ↻ to refresh';
          tablesCacheHint.style.display = '';
        } else {
          tablesCacheHint.style.display = 'none';
        }
      } else if (m.type === 'queryStarted') {
        statusEl.textContent = 'Submitted: ' + m.executionId.slice(0, 8) + '… polling';
      } else if (m.type === 'queryState') {
        statusEl.textContent = m.state + '…';
        renderState(m.state, m.stats);
      } else if (m.type === 'queryFinished') {
        endRunning();
        renderState(m.state, m.stats);
        if (m.state === 'SUCCEEDED') {
          renderResults(m.columns, m.rows, m.truncated);
        } else {
          showError(m.error || (m.state + ' (no reason given)'));
        }
      } else if (m.type === 'queryCancelled') {
        endRunning();
        statusEl.textContent = 'Cancelled';
      } else if (m.type === 'error') {
        endRunning();
        showError(m.message || 'Unknown error');
        // If the user kicked off a refresh and the bootstrap blew up,
        // unstick the button so they can retry.
        refreshTablesBtn.disabled = false;
        refreshTablesBtn.textContent = '↻';
      }
    });

    // Cmd/Ctrl+Enter to run.
    sqlInput.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runBtn.click();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Convert an Athena `Row` into a string array, padding/truncating to expected width. */
function rowToValues(row: Row, expectedWidth: number): string[] {
  const data: Datum[] = row.Data ?? [];
  const out: string[] = [];
  for (let i = 0; i < expectedWidth; i++) {
    out.push(data[i]?.VarCharValue ?? "");
  }
  return out;
}
