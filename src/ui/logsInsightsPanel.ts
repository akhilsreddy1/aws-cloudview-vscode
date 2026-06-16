import * as vscode from "vscode";
import * as fs from "fs/promises";
import {
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsProfileSession } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";
import { readCloudViewConfiguration } from "../core/config";
import { requireSelectedSessions } from "./profileGuards";

interface PanelScope {
  session: AwsProfileSession;
  region: string;
}

/**
 * Options for {@link LogsInsightsPanel.open} when called from a context that
 * already knows the scope + a starting log group (e.g. the log-streams panel
 * opens it pre-scoped to the group the user just clicked into). When omitted,
 * the entry point falls back to its standalone flow (palette command):
 * prompt for profile + region, no log groups pre-selected.
 */
export interface OpenOptions {
  /**
   * Skip the profile/region quick-picks and use the given AWS account + region
   * directly. The session is resolved from the user's selected profiles by
   * matching accountId.
   */
  scope?: { accountId: string; region: string };
  /** Pre-tick this log group in the pickers, ready for an immediate query. */
  prefilledLogGroup?: string;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_MAX_INTERVAL_MS = 5_000;
/** Max log-group choices we offer in the picker; >50 gets unwieldy. */
const LOG_GROUP_PICKER_LIMIT = 50;
/** CloudWatch Logs Insights hard cap on result rows per query. */
const RESULTS_LIMIT = 10_000;
/** Default rows we ask for if user doesn't specify a LIMIT in their query. */
const DEFAULT_RESULTS_LIMIT = 1_000;

const TIME_RANGE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "Last 15 minutes", minutes: 15 },
  { label: "Last 1 hour", minutes: 60 },
  { label: "Last 3 hours", minutes: 180 },
  { label: "Last 12 hours", minutes: 720 },
  { label: "Last 24 hours", minutes: 1440 },
  { label: "Last 7 days", minutes: 10080 },
];

const DEFAULT_QUERY = `fields @timestamp, @message
| sort @timestamp desc
| limit 100`;

/**
 * CloudWatch Logs Insights query runner. Pick log groups (from the cache of
 * discovered groups), a time range, write a CWLI query, hit Run. We submit
 * via `StartQuery`, poll `GetQueryResults` with exponential backoff, render
 * the result rows as a sticky-header table when the query completes.
 *
 * Cancel calls `StopQuery`. Closing the panel auto-cancels any in-flight
 * query so you don't keep paying for it.
 */
export class LogsInsightsPanel {
  private static panels = new Map<string, LogsInsightsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly key: string;

  /** Current running queryId, or undefined if idle. */
  private runningQueryId?: string;
  /**
   * Log group to pre-tick on first bootstrap. Cleared after the first
   * bootstrap message so a region-switch doesn't re-impose it.
   */
  private pendingPrefilledLogGroup?: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private scope: PanelScope,
    prefilledLogGroup?: string,
  ) {
    this.pendingPrefilledLogGroup = prefilledLogGroup;
    this.key = `${scope.session.profileName}|${scope.session.accountId}|${scope.region}`;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLogsInsights",
      `Logs Insights: ${scope.session.profileName} · ${scope.region}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      LogsInsightsPanel.panels.delete(this.key);
      // Best-effort cancel on close.
      if (this.runningQueryId) void this.cancelQuery(this.runningQueryId);
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          await this.bootstrap();
        } else if (msg.type === "runQuery") {
          await this.runQuery({
            queryString: String(msg.queryString ?? ""),
            logGroupNames: Array.isArray(msg.logGroupNames) ? (msg.logGroupNames as string[]) : [],
            startTimeMs: Number(msg.startTimeMs) || (Date.now() - 60 * 60 * 1000),
            endTimeMs: Number(msg.endTimeMs) || Date.now(),
          });
        } else if (msg.type === "cancelQuery" && this.runningQueryId) {
          await this.cancelQuery(this.runningQueryId);
        } else if (msg.type === "changeRegion" && typeof msg.region === "string") {
          await this.changeRegion(msg.region);
        } else if (msg.type === "downloadCsv" && typeof msg.csv === "string") {
          await this.downloadCsv(
            msg.csv,
            typeof msg.suggestedName === "string" ? msg.suggestedName : "logs-insights-results.csv",
          );
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  /**
   * Entry point. Two modes:
   *
   *  1. **Standalone** (called from the palette command with no options) —
   *     prompts the user for profile + region via QuickPick.
   *  2. **Scoped** (called from the Log Streams panel with `opts.scope` set)
   *     — skips the pickers and uses the given account+region directly,
   *     plus pre-ticks the log group the user came from.
   */
  public static async open(platform: CloudViewPlatform, opts: OpenOptions = {}): Promise<void> {
    const sessions = await requireSelectedSessions(platform, "run Logs Insights queries");
    if (!sessions) return;

    let session: AwsProfileSession | undefined;
    let region: string;

    if (opts.scope) {
      // Scoped path: bind to the same (account, region) as the calling
      // resource without prompting. If no selected profile matches the
      // account, fall back to the standalone flow.
      session = sessions.find((s) => s.accountId === opts.scope!.accountId);
      if (!session) {
        void vscode.window.showWarningMessage(
          `No selected AWS profile resolves to account ${opts.scope.accountId}. Select that profile first via CloudView: Select AWS Profiles.`,
        );
        return;
      }
      region = opts.scope.region;
    } else {
      // Standalone path: pick profile + region.
      session = sessions[0];
      if (sessions.length > 1) {
        const picked = await vscode.window.showQuickPick(
          sessions.map((s) => ({ label: s.profileName, description: s.accountId, _session: s })),
          { title: "Logs Insights: pick a profile", placeHolder: "Profile to run queries against" },
        );
        if (!picked) return;
        session = picked._session;
      }
      const cfg = readCloudViewConfiguration();
      const realRegions = cfg.regions.filter((r) => r !== "global");
      region = session.defaultRegion ?? realRegions[0] ?? "us-east-1";
      if (realRegions.length > 1) {
        const picked = await vscode.window.showQuickPick(realRegions, {
          title: "Logs Insights: pick a region",
          placeHolder: "Region for Logs Insights queries",
        });
        if (!picked) return;
        region = picked;
      }
    }

    const key = `${session.profileName}|${session.accountId}|${region}`;
    const existing = LogsInsightsPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      // If caller is re-entering with a different prefilled group, push it
      // into the existing panel rather than ignoring it.
      if (opts.prefilledLogGroup) {
        void existing.panel.webview.postMessage({
          type: "prefillLogGroup",
          logGroupName: opts.prefilledLogGroup,
        });
      }
      return;
    }
    const instance = new LogsInsightsPanel(platform, { session, region }, opts.prefilledLogGroup);
    LogsInsightsPanel.panels.set(key, instance);
  }

  // ─── Bootstrap (log groups) ──────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    // We pull log groups from the local resource cache rather than calling
    // DescribeLogGroups again — that's the whole point of having the
    // discovery layer. Falls back to an empty list if logs haven't been
    // discovered yet.
    const cached = await this.platform.resourceRepo.listByMultiScope({
      service: "logs",
      accountIds: [this.scope.session.accountId],
      regions: [this.scope.region],
    });
    const logGroups = cached
      .filter((r) => r.type === "aws.logs.log-group")
      .map((r) => r.name || r.id)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .sort();

    // Pull the prefilled group only on first bootstrap. A subsequent
    // region-switch (which also calls bootstrap) shouldn't re-impose the
    // initial group — the user has moved on by then.
    const prefilledLogGroup = this.pendingPrefilledLogGroup;
    this.pendingPrefilledLogGroup = undefined;

    void this.panel.webview.postMessage({
      type: "bootstrap",
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
      regions: readCloudViewConfiguration().regions.filter((r) => r !== "global"),
      logGroups,
      logGroupsTruncated: logGroups.length > LOG_GROUP_PICKER_LIMIT,
      defaultQuery: DEFAULT_QUERY,
      timeRangePresets: TIME_RANGE_PRESETS,
      hasDiscoveredLogs: logGroups.length > 0,
      prefilledLogGroup,
    });
  }

  // ─── Query execution ────────────────────────────────────────────────────

  private async runQuery(args: {
    queryString: string;
    logGroupNames: string[];
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<void> {
    if (!args.queryString.trim()) {
      this.postError("Query is empty.");
      return;
    }
    if (args.logGroupNames.length === 0) {
      this.postError("Pick at least one log group.");
      return;
    }
    if (this.runningQueryId) {
      this.postError("A query is already running. Cancel it first.");
      return;
    }
    if (args.endTimeMs <= args.startTimeMs) {
      this.postError("End time must be after start time.");
      return;
    }

    const client = await this.platform.awsClientFactory.cloudwatchLogs({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });

    let queryId: string;
    try {
      const startResp = await this.platform.scheduler.run("cloudwatchLogs", "StartQuery", () =>
        client.send(new StartQueryCommand({
          queryString: args.queryString,
          // CWLI takes seconds, not ms.
          startTime: Math.floor(args.startTimeMs / 1000),
          endTime: Math.floor(args.endTimeMs / 1000),
          logGroupNames: args.logGroupNames,
          // Honors a `| limit N` in the query, otherwise falls back to this.
          limit: DEFAULT_RESULTS_LIMIT,
        }))
      );
      queryId = startResp.queryId ?? "";
      if (!queryId) throw new Error("CloudWatch Logs did not return a query id");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most common: malformed query syntax. CWLI errors are usually
      // clear enough on their own; no extra friendly-wrap needed.
      this.postError(`StartQuery failed: ${msg}`);
      return;
    }

    this.runningQueryId = queryId;
    void this.panel.webview.postMessage({ type: "queryStarted", queryId });

    // Poll for completion, exponential-ish backoff up to 5s.
    let interval = POLL_INTERVAL_MS;
    while (true) {
      await new Promise((r) => setTimeout(r, interval));
      // User cancelled (or panel was closed) while sleeping.
      if (this.runningQueryId !== queryId) {
        return;
      }
      let resp;
      try {
        resp = await this.platform.scheduler.run("cloudwatchLogs", "GetQueryResults", () =>
          client.send(new GetQueryResultsCommand({ queryId }))
        );
      } catch (err: unknown) {
        this.runningQueryId = undefined;
        this.postError(`GetQueryResults failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const status = resp.status ?? "Unknown";
      const stats = {
        recordsMatched: resp.statistics?.recordsMatched,
        recordsScanned: resp.statistics?.recordsScanned,
        bytesScanned: resp.statistics?.bytesScanned,
      };
      void this.panel.webview.postMessage({ type: "queryState", queryId, status, stats });

      if (status === "Complete" || status === "Failed" || status === "Cancelled" || status === "Timeout") {
        this.runningQueryId = undefined;
        if (status === "Complete") {
          const { columns, rows } = flattenResults(resp.results ?? []);
          void this.panel.webview.postMessage({
            type: "queryFinished",
            queryId,
            status,
            stats,
            columns,
            rows,
            truncated: rows.length >= RESULTS_LIMIT,
          });
        } else {
          void this.panel.webview.postMessage({
            type: "queryFinished",
            queryId,
            status,
            stats,
            error: status === "Cancelled" ? "Cancelled by user" : `Query finished with status ${status}`,
          });
        }
        return;
      }
      interval = Math.min(POLL_MAX_INTERVAL_MS, Math.floor(interval * 1.25));
    }
  }

  private async cancelQuery(queryId: string): Promise<void> {
    const client = await this.platform.awsClientFactory.cloudwatchLogs({
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    });
    try {
      await this.platform.scheduler.run("cloudwatchLogs", "StopQuery", () =>
        client.send(new StopQueryCommand({ queryId }))
      );
    } catch {
      // Best-effort: even if StopQuery fails (already finished), the poll
      // loop will detect terminal status and clear runningQueryId.
    }
    if (this.runningQueryId === queryId) {
      this.runningQueryId = undefined;
    }
    void this.panel.webview.postMessage({ type: "queryCancelled", queryId });
  }

  private async changeRegion(region: string): Promise<void> {
    if (region === this.scope.region) return;
    this.scope = { ...this.scope, region };
    this.panel.title = `Logs Insights: ${this.scope.session.profileName} · ${region}`;
    await this.bootstrap();
  }

  /**
   * Save the webview-rendered CSV string to a user-chosen file. The CSV is
   * built in the webview from the already-fetched result rows (no extra
   * CloudWatch round-trip). Defaults the save dialog to the first workspace
   * folder, or the home directory if no workspace is open.
   */
  private async downloadCsv(csv: string, suggestedName: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultDir = workspaceFolder?.fsPath ?? require("os").homedir();
    const defaultUri = vscode.Uri.file(`${defaultDir}/${suggestedName}`);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "CSV": ["csv"], "All files": ["*"] },
      saveLabel: "Save results",
      title: "Save Logs Insights query results",
    });
    if (!target) return;
    try {
      await fs.writeFile(target.fsPath, csv, "utf8");
      const open = "Open file";
      const choice = await vscode.window.showInformationMessage(
        `Saved Logs Insights results to ${target.fsPath}.`,
        open,
      );
      if (choice === open) {
        await vscode.commands.executeCommand("vscode.open", target);
      }
    } catch (err: unknown) {
      this.postError(`Could not write CSV: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  // ─── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const n = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>CloudWatch Logs Insights</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #6d28d9; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar select, .toolbar input {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .toolbar .grow { flex: 1; }
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

    .lg-picker-row { padding: 10px 20px 0; flex-shrink: 0; display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
    .lg-picker-row label { font-size: 11px; color: var(--muted); font-weight: 600; padding-top: 6px; }
    .lg-chips {
      flex: 1; min-width: 320px; display: flex; flex-wrap: wrap; gap: 4px;
      padding: 6px; background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--radius-sm); min-height: 32px;
    }
    .lg-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: #ede9fe; color: #5b21b6;
      padding: 2px 6px 2px 8px; border-radius: 12px; font-size: 11px;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .lg-chip button { background: transparent; border: 0; color: inherit; cursor: pointer; font-size: 13px; padding: 0 2px; }
    .lg-chip-empty { color: var(--muted); font-size: 11px; padding: 4px 8px; }

    .editor-wrap { padding: 10px 20px 0; flex-shrink: 0; }
    textarea#query {
      width: 100%; min-height: 120px; max-height: 240px; resize: vertical;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 10px 12px; border-radius: var(--radius); font-size: 13px;
      font-family: 'SF Mono', 'Fira Code', Menlo, monospace; line-height: 1.5;
      tab-size: 2;
    }
    .run-row { display: flex; gap: 8px; align-items: center; padding: 8px 20px 12px; flex-shrink: 0; }

    .summary-row { padding: 8px 20px; font-size: 11px; color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; gap: 16px; flex-wrap: wrap; }
    .summary-row strong { color: var(--text-2); font-weight: 600; }
    .state-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
    .state-Scheduled, .state-Running { background: #fef3c7; color: #92400e; }
    .state-Complete { background: #dcfce7; color: #166534; }
    .state-Failed, .state-Cancelled, .state-Timeout { background: #fee2e2; color: #991b1b; }

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
      max-width: 600px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text);
    }
    table.results tbody tr:hover td { background: var(--surface-2); }

    .truncated-banner { padding: 8px 20px; font-size: 11px; background: #fef3c7; color: #92400e; border-top: 1px solid #fde68a; }
    .results-toolbar { display: flex; gap: 8px; align-items: center; padding: 6px 20px; border-bottom: 1px solid var(--border); background: var(--surface-2); font-size: 11px; color: var(--muted); }
    .results-toolbar .row-count { margin-right: auto; }
    .btn-csv { background: transparent; border: 1px solid var(--border-2); color: var(--text); padding: 4px 10px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; cursor: pointer; }
    .btn-csv:hover { background: var(--surface-3); }
    .no-logs-banner { padding: 12px 20px; font-size: 12px; background: #fef3c7; color: #92400e; border-bottom: 1px solid #fde68a; }
    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none; white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F50D}</span>
      <span>CloudWatch Logs Insights</span>
    </div>
    <div class="meta">
      <span><span class="label">Profile:</span> <span id="hdr-profile">…</span></span>
      <span><span class="label">Account:</span> <span id="hdr-account">…</span></span>
      <span><span class="label">Region:</span>
        <select id="region-select" style="margin-left:4px;font-size:11px;padding:2px 6px;"><option>…</option></select>
      </span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>
  <div class="no-logs-banner" id="no-logs-banner" style="display:none;">
    No CloudWatch log groups found in the local cache for this account &amp; region.
    Run <strong>CloudView: Refresh Resources</strong> (or click <strong>Refresh</strong> on the Services view) so the Logs service is discovered, then reopen this panel.
  </div>

  <div class="toolbar">
    <label>Time range</label>
    <select id="time-range"></select>
  </div>

  <div class="lg-picker-row">
    <label>Log groups</label>
    <div class="lg-chips" id="lg-chips"><span class="lg-chip-empty">(none selected)</span></div>
    <button class="btn ghost" id="lg-pick-btn">+ Pick log groups</button>
    <button class="btn ghost" id="lg-clear-btn" style="font-size:10px;padding:4px 8px;">Clear</button>
  </div>

  <div class="editor-wrap">
    <textarea id="query" spellcheck="false"></textarea>
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
      <div class="icon">\u{1F50D}</div>
      <div>Pick log groups, set a time range, write a query and click <strong>Run</strong>.</div>
      <div style="font-size:11px;margin-top:6px;">CloudWatch Logs Insights bills per GB scanned. Use specific log groups + narrow time ranges.</div>
    </div>
    <div id="results-wrap" style="display:none;overflow:auto;max-height:100%;">
      <div class="results-toolbar" id="results-toolbar" style="display:none;">
        <span class="row-count" id="row-count"></span>
        <button class="btn-csv" id="download-csv-btn" title="Download these rows as a CSV file">⬇ Download CSV</button>
      </div>
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
    var timeRangeSel = document.getElementById('time-range');
    var lgChips = document.getElementById('lg-chips');
    var lgPickBtn = document.getElementById('lg-pick-btn');
    var lgClearBtn = document.getElementById('lg-clear-btn');
    var queryInput = document.getElementById('query');
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
    var noLogsBanner = document.getElementById('no-logs-banner');

    // Local state
    var availableLogGroups = [];
    var selectedLogGroups = [];

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) { errorBanner.textContent = msg; errorBanner.style.display = 'block'; }
    function clearError() { errorBanner.style.display = 'none'; }
    function fmtBytes(n) {
      if (!n || !isFinite(n)) return '0 B';
      var u = ['B','KB','MB','GB','TB']; var i = Math.floor(Math.log(n) / Math.log(1024));
      return (n / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
    }

    function renderChips() {
      if (selectedLogGroups.length === 0) {
        lgChips.innerHTML = '<span class="lg-chip-empty">(none selected)</span>';
        return;
      }
      lgChips.innerHTML = selectedLogGroups.map(function(name, idx) {
        return '<span class="lg-chip">' + esc(name) + '<button data-idx="' + idx + '" title="Remove">×</button></span>';
      }).join('');
      lgChips.querySelectorAll('button').forEach(function(b) {
        b.onclick = function() {
          var i = parseInt(b.getAttribute('data-idx'), 10);
          selectedLogGroups.splice(i, 1);
          renderChips();
        };
      });
    }

    lgPickBtn.onclick = function() {
      // We don't have a native multi-select inside webview without dependency
      // bloat, so we delegate to a tiny prompt-style flow: ask backend to open
      // a QuickPick (not implemented as it requires extension-side support).
      // For v1 we use a comma-separated prompt fallback.
      var seed = selectedLogGroups.join(', ');
      var hint = availableLogGroups.length > 0
        ? 'Available: ' + availableLogGroups.slice(0, 10).join(', ') + (availableLogGroups.length > 10 ? ', …' : '')
        : '';
      var input = window.prompt('Log groups (comma-separated). ' + hint, seed);
      if (input == null) return;
      var parsed = input.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      selectedLogGroups = parsed;
      renderChips();
    };
    lgClearBtn.onclick = function() { selectedLogGroups = []; renderChips(); };

    runBtn.onclick = function() {
      clearError();
      var preset = timeRangeSel.value;
      var endMs = Date.now();
      var startMs = endMs - (parseInt(preset, 10) * 60 * 1000);
      vscode.postMessage({
        type: 'runQuery',
        queryString: queryInput.value,
        logGroupNames: selectedLogGroups,
        startTimeMs: startMs,
        endTimeMs: endMs,
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

    function renderState(status, stats) {
      var bits = ['<span class="state-badge state-' + esc(status) + '">' + esc(status) + '</span>'];
      if (stats && stats.recordsMatched != null) bits.push('matched: <strong>' + stats.recordsMatched.toLocaleString() + '</strong>');
      if (stats && stats.recordsScanned != null) bits.push('scanned: <strong>' + stats.recordsScanned.toLocaleString() + '</strong>');
      if (stats && stats.bytesScanned != null) bits.push('bytes scanned: <strong>' + fmtBytes(stats.bytesScanned) + '</strong>');
      summary.innerHTML = bits.join(' · ');
      summary.style.display = 'flex';
    }

    // Latest result set, retained so the "Download CSV" button can re-encode
    // the rows in CSV without re-running the query against CloudWatch.
    var latestColumns = [];
    var latestRows = [];

    function renderResults(columns, rows, truncated) {
      latestColumns = columns || [];
      latestRows = rows || [];
      emptyEl.style.display = 'none';
      resultsWrap.style.display = '';
      resultsHead.innerHTML = latestColumns.map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('');
      resultsBody.innerHTML = latestRows.map(function(r) {
        return '<tr>' + latestColumns.map(function(c) {
          var v = r[c];
          return '<td title="' + esc(v) + '">' + esc(v) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      var hasRows = latestRows.length > 0;
      document.getElementById('results-toolbar').style.display = hasRows ? 'flex' : 'none';
      document.getElementById('row-count').textContent = hasRows
        ? (latestRows.length + ' row' + (latestRows.length === 1 ? '' : 's') + (truncated ? ' (truncated)' : ''))
        : '';
      truncatedEl.style.display = truncated ? '' : 'none';
      if (truncated) {
        truncatedEl.textContent = 'Showing first ' + latestRows.length + ' rows. Refine the query (narrower time range, more selective filters, or add LIMIT) for fewer results.';
      }
    }

    // RFC-4180-flavoured CSV: wrap a field in double quotes if it contains a
    // comma, double-quote, CR, or LF; double up any existing quotes inside.
    function csvField(v) {
      var s = v == null ? '' : String(v);
      if (/[",\\r\\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }
    function buildCsv() {
      var lines = [];
      lines.push(latestColumns.map(csvField).join(','));
      for (var i = 0; i < latestRows.length; i++) {
        var row = latestRows[i];
        lines.push(latestColumns.map(function(c) { return csvField(row[c]); }).join(','));
      }
      return lines.join('\\r\\n') + '\\r\\n';
    }
    document.getElementById('download-csv-btn').onclick = function() {
      if (latestRows.length === 0) return;
      var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      vscode.postMessage({
        type: 'downloadCsv',
        csv: buildCsv(),
        suggestedName: 'logs-insights-' + stamp + '.csv',
      });
    };

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
        timeRangeSel.innerHTML = (m.timeRangePresets || []).map(function(p, i) {
          return '<option value="' + p.minutes + '"' + (i === 1 ? ' selected' : '') + '>' + esc(p.label) + '</option>';
        }).join('');
        availableLogGroups = m.logGroups || [];
        queryInput.value = m.defaultQuery || '';
        if (!m.hasDiscoveredLogs) {
          noLogsBanner.style.display = '';
        } else {
          noLogsBanner.style.display = 'none';
        }
        // Pre-tick the log group the caller passed in (when launched from
        // the Log Streams panel). Dedupes if the user already added it.
        if (m.prefilledLogGroup && selectedLogGroups.indexOf(m.prefilledLogGroup) === -1) {
          selectedLogGroups.push(m.prefilledLogGroup);
        }
        renderChips();
      } else if (m.type === 'prefillLogGroup') {
        // Existing panel reused with a new log group — append + focus.
        if (m.logGroupName && selectedLogGroups.indexOf(m.logGroupName) === -1) {
          selectedLogGroups.push(m.logGroupName);
          renderChips();
        }
      } else if (m.type === 'queryStarted') {
        statusEl.textContent = 'Submitted: ' + m.queryId.slice(0, 8) + '… polling';
      } else if (m.type === 'queryState') {
        statusEl.textContent = m.status + '…';
        renderState(m.status, m.stats);
      } else if (m.type === 'queryFinished') {
        endRunning();
        renderState(m.status, m.stats);
        if (m.status === 'Complete') {
          renderResults(m.columns, m.rows, m.truncated);
        } else {
          showError(m.error || (m.status + ' (no reason given)'));
        }
      } else if (m.type === 'queryCancelled') {
        endRunning();
        statusEl.textContent = 'Cancelled';
      } else if (m.type === 'error') {
        endRunning();
        showError(m.message || 'Unknown error');
      }
    });

    queryInput.addEventListener('keydown', function(e) {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * CWLI returns `results` as `ResultField[][]` — each row is an array of
 * `{ field, value }` pairs (the field set CAN vary across rows). Flatten
 * into `{columns, rows}` where columns is the union of fields seen across
 * all rows in the order they first appear, and each row is `Record<field,value>`.
 */
function flattenResults(results: ResultField[][]): { columns: string[]; rows: Record<string, string>[] } {
  const seenColumns: string[] = [];
  const seenColumnSet = new Set<string>();
  const rows: Record<string, string>[] = [];

  for (const row of results) {
    const obj: Record<string, string> = {};
    for (const field of row) {
      const name = field.field ?? "";
      const value = field.value ?? "";
      if (!name) continue;
      // CWLI emits a synthetic `@ptr` column on every row — useful for
      // `stats` queries but noise for normal SELECT-style ones. Hide it
      // by default; users who need it can edit the query to expose it.
      if (name === "@ptr") continue;
      if (!seenColumnSet.has(name)) {
        seenColumnSet.add(name);
        seenColumns.push(name);
      }
      obj[name] = value;
    }
    rows.push(obj);
  }
  return { columns: seenColumns, rows };
}
