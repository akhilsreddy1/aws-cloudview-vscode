import * as vscode from "vscode";
import {
  GetJobRunsCommand,
  StartJobRunCommand,
  BatchStopJobRunCommand,
  type JobRun,
} from "@aws-sdk/client-glue";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";
import { LogStreamsPanel } from "./logStreamsPanel";

/** Poll cadence while any run is in a non-terminal state. */
const POLL_INTERVAL_MS = 6_000;
const RUNS_LIMIT = 50;
const TERMINAL_RUN_STATES = new Set<string>([
  "SUCCEEDED", "FAILED", "STOPPED", "TIMEOUT", "ERROR",
]);

/**
 * Glue ETL job runs panel: list recent runs, trigger a new run, watch
 * in-progress runs update live, and jump to the per-run CloudWatch logs.
 *
 * - **List**: `GetJobRuns` (most recent first).
 * - **Trigger**: `StartJobRun` after a confirmation modal.
 * - **Status**: polls `GetJobRuns` every 6s while any run is non-terminal
 *   (STARTING / RUNNING / STOPPING); stops once everything is terminal.
 * - **Stop**: `BatchStopJobRun` for an in-progress run.
 * - **Logs**: each run deep-links to its `/aws-glue/jobs/output` and
 *   `/aws-glue/jobs/error` log streams (stream name == JobRunId).
 */
export class GlueJobRunsPanel {
  private static panels = new Map<string, GlueJobRunsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly jobName: string;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.jobName = (resource.rawJson.JobName as string) || resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewGlueJobRuns",
      `Glue: ${this.jobName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.stopPolling();
      GlueJobRunsPanel.panels.delete(resource.arn);
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "refresh") {
          await this.loadRuns();
        } else if (msg.type === "runJob") {
          await this.triggerRun();
        } else if (msg.type === "stopRun" && typeof msg.runId === "string") {
          await this.stopRun(msg.runId);
        } else if (msg.type === "viewLogs" && typeof msg.runId === "string" && typeof msg.logGroup === "string") {
          await this.openRunLogs(msg.logGroup, msg.runId);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = GlueJobRunsPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new GlueJobRunsPanel(platform, resource);
    GlueJobRunsPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  // ─── List + poll ──────────────────────────────────────────────────────────

  private async loadRuns(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.glue(scope);

    let runs: JobRun[] = [];
    try {
      const resp = await this.platform.scheduler.run("glue", "GetJobRuns", () =>
        client.send(new GetJobRunsCommand({ JobName: this.jobName, MaxResults: RUNS_LIMIT }))
      );
      runs = resp.JobRuns ?? [];
    } catch (err: unknown) {
      this.postError(`GetJobRuns failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const rows = runs.map(serializeRun);
    void this.panel.webview.postMessage({
      type: "runs",
      rows,
      outputLogGroup: (this.resource.rawJson.OutputLogGroup as string) ?? "/aws-glue/jobs/output",
      errorLogGroup: (this.resource.rawJson.ErrorLogGroup as string) ?? "/aws-glue/jobs/error",
    });

    // Keep polling while any run is mid-flight.
    const anyInFlight = runs.some((r) => r.JobRunState && !TERMINAL_RUN_STATES.has(r.JobRunState));
    this.stopPolling();
    if (anyInFlight && !this.disposed) {
      this.pollTimer = setTimeout(() => {
        void this.loadRuns().catch((err) => this.postError(String(err)));
      }, POLL_INTERVAL_MS);
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ─── Trigger ────────────────────────────────────────────────────────────────

  private async triggerRun(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Start a new run of Glue job "${this.jobName}"?`,
      {
        modal: true,
        detail: `Region: ${this.resource.region}\nAccount: ${this.resource.accountId}\n\nThis starts a billable job run using the job's default arguments. Worker capacity and runtime depend on the job configuration.`,
      },
      "Start run",
    );
    if (confirm !== "Start run") return;

    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.glue(scope);
    try {
      const resp = await this.platform.scheduler.run("glue", "StartJobRun", () =>
        client.send(new StartJobRunCommand({ JobName: this.jobName }))
      );
      void vscode.window.showInformationMessage(
        `Started Glue job "${this.jobName}" (run ${resp.JobRunId?.slice(0, 24) ?? "unknown"}…).`,
      );
      // Refresh shortly after so the new run shows up + polling kicks in.
      setTimeout(() => void this.loadRuns().catch(() => { /* best-effort */ }), 1500);
    } catch (err: unknown) {
      this.postError(`StartJobRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async stopRun(runId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Stop in-progress run ${runId.slice(0, 24)}… of "${this.jobName}"?`,
      { modal: true, detail: "Glue will stop the job run. Already-processed data is not rolled back." },
      "Stop run",
    );
    if (confirm !== "Stop run") return;

    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.glue(scope);
    try {
      await this.platform.scheduler.run("glue", "BatchStopJobRun", () =>
        client.send(new BatchStopJobRunCommand({ JobName: this.jobName, JobRunIds: [runId] }))
      );
      void vscode.window.showInformationMessage(`Stop requested for run ${runId.slice(0, 24)}….`);
      setTimeout(() => void this.loadRuns().catch(() => { /* best-effort */ }), 1500);
    } catch (err: unknown) {
      this.postError(`BatchStopJobRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Open the per-run logs. Glue writes each run's logs to a CloudWatch log
   * stream named after the JobRunId, under `/aws-glue/jobs/output` (driver
   * stdout) and `/aws-glue/jobs/error` (stderr / Spark logs). We synthesise a
   * log-group resource node and hand off to the existing {@link LogStreamsPanel}
   * scoped to that group; the stream matching the run id is surfaced so the
   * user can open it directly. Glue ETL job-run logs live in `us-east-1`-style
   * default groups in the job's own region.
   */
  private async openRunLogs(logGroup: string, runId: string): Promise<void> {
    const { accountId, region } = this.resource;
    const arn = `arn:aws:logs:${region}:${accountId}:log-group:${logGroup}:*`;
    const logGroupResource: ResourceNode = {
      arn,
      id: logGroup,
      type: ResourceTypes.logGroup,
      service: "logs",
      accountId,
      region,
      name: logGroup,
      tags: {},
      rawJson: { LogGroupName: logGroup, Source: "AWS Glue" },
      lastUpdated: Date.now(),
    };
    void vscode.window.showInformationMessage(
      `Opening ${logGroup} — the log stream for this run is named "${runId}".`,
    );
    await LogStreamsPanel.open(this.platform, logGroupResource);
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  // ─── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.jobName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const jobType = escapeHtml((this.resource.rawJson.JobType as string) ?? "glueetl");
    const glueVersion = escapeHtml((this.resource.rawJson.GlueVersion as string) ?? "");
    const workerType = escapeHtml((this.resource.rawJson.WorkerType as string) ?? "");
    const workers = escapeHtml(String(this.resource.rawJson.NumberOfWorkers ?? ""));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Glue: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #c925d1; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono', 'Fira Code', monospace; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .btn { background: var(--accent); color: #fff; border: none; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }
    .polling-note { margin-left: auto; font-size: 11px; color: var(--muted); display: none; align-items: center; gap: 6px; }
    .polling-note .pulse { width: 6px; height: 6px; border-radius: 50%; background: #d97706; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

    .content { flex: 1; overflow: auto; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    table.runs { border-collapse: collapse; font-size: 12px; width: 100%; }
    table.runs thead th { background: var(--surface-2); position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; color: var(--text); white-space: nowrap; }
    table.runs tbody td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; color: var(--text); }
    table.runs tbody tr:hover td { background: var(--surface-2); }
    .run-id { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); }
    .ts { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .err-msg { color: #b91c1c; max-width: 380px; word-wrap: break-word; }

    .state-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .3px; }
    .state-SUCCEEDED { background: #dcfce7; color: #166534; }
    .state-FAILED, .state-ERROR, .state-TIMEOUT { background: #fee2e2; color: #991b1b; }
    .state-RUNNING, .state-STARTING { background: #fef3c7; color: #92400e; }
    .state-STOPPING, .state-STOPPED { background: #e5e7eb; color: #374151; }

    .row-btn { padding: 2px 8px; border-radius: 8px; border: 1px solid var(--border-2); background: transparent; color: var(--text); font-size: 11px; cursor: pointer; margin-right: 4px; }
    .row-btn:hover { background: var(--surface-3); }
    .row-btn.stop { border-color: #b91c1c; color: #b91c1c; }
    .row-btn.stop:hover { background: #fef2f2; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F517}</span>
      <span>${name}</span>
      <span class="state-pill state-STOPPED">${jobType}</span>
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      ${glueVersion ? `<span><span class="label">Glue:</span> ${glueVersion}</span>` : ""}
      ${workerType ? `<span><span class="label">Workers:</span> ${workers} × ${workerType}</span>` : ""}
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <button class="btn" id="run-btn">▶ Run job</button>
    <button class="btn ghost" id="refresh-btn">↻ Refresh</button>
    <span class="polling-note" id="polling-note"><span class="pulse"></span> live — polling running jobs</span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F517}</div>
      <div>Loading job runs…</div>
    </div>
    <table class="runs" id="runs-table" style="display:none;">
      <thead>
        <tr>
          <th>State</th>
          <th>Run ID</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Error</th>
          <th>Logs / Actions</th>
        </tr>
      </thead>
      <tbody id="runs-body"></tbody>
    </table>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var runBtn = document.getElementById('run-btn');
    var refreshBtn = document.getElementById('refresh-btn');
    var pollingNote = document.getElementById('polling-note');
    var emptyEl = document.getElementById('empty');
    var table = document.getElementById('runs-table');
    var tbody = document.getElementById('runs-body');
    var errorBanner = document.getElementById('error-banner');
    var outputLogGroup = '/aws-glue/jobs/output';
    var errorLogGroup = '/aws-glue/jobs/error';

    var TERMINAL = { SUCCEEDED:1, FAILED:1, STOPPED:1, TIMEOUT:1, ERROR:1 };

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg){ errorBanner.textContent = msg; errorBanner.style.display='block'; setTimeout(function(){errorBanner.style.display='none';}, 9000); }

    function fmtTs(iso){ if(!iso) return '—'; try { return new Date(iso).toLocaleString(); } catch(_) { return String(iso); } }
    function fmtDur(sec){ if(sec==null) return '—'; if(sec<60) return sec+'s'; var m=Math.floor(sec/60), s=sec%60; return m+'m '+(s?s+'s':''); }

    function render(rows) {
      if (!rows.length) {
        emptyEl.style.display='flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'No runs yet. Click "Run job" to start one.';
        table.style.display='none';
        return;
      }
      emptyEl.style.display='none';
      table.style.display='';
      var anyInFlight = false;
      var html = '';
      for (var i=0;i<rows.length;i++){
        var r = rows[i];
        var inFlight = !TERMINAL[r.state];
        if (inFlight) anyInFlight = true;
        var logsBtns =
          '<button class="row-btn" data-logs-run="' + esc(r.id) + '" data-logs-group="' + esc(outputLogGroup) + '" title="View output (driver) logs">output logs</button>' +
          '<button class="row-btn" data-logs-run="' + esc(r.id) + '" data-logs-group="' + esc(errorLogGroup) + '" title="View error (Spark) logs">error logs</button>';
        var stopBtn = inFlight ? '<button class="row-btn stop" data-stop-run="' + esc(r.id) + '">⏹ Stop</button>' : '';
        html += '<tr>' +
          '<td><span class="state-pill state-' + esc(r.state) + '">' + esc(r.state) + '</span></td>' +
          '<td class="run-id">' + esc(r.id) + '</td>' +
          '<td class="ts">' + esc(fmtTs(r.started)) + '</td>' +
          '<td>' + esc(fmtDur(r.durationSec)) + '</td>' +
          '<td class="err-msg">' + esc(r.errorMessage || '') + '</td>' +
          '<td>' + logsBtns + stopBtn + '</td>' +
        '</tr>';
      }
      tbody.innerHTML = html;
      pollingNote.style.display = anyInFlight ? 'flex' : 'none';

      tbody.querySelectorAll('[data-logs-run]').forEach(function(b){
        b.onclick = function(){ vscode.postMessage({ type:'viewLogs', runId:b.getAttribute('data-logs-run'), logGroup:b.getAttribute('data-logs-group') }); };
      });
      tbody.querySelectorAll('[data-stop-run]').forEach(function(b){
        b.onclick = function(){ vscode.postMessage({ type:'stopRun', runId:b.getAttribute('data-stop-run') }); };
      });
    }

    runBtn.onclick = function(){ vscode.postMessage({ type:'runJob' }); };
    refreshBtn.onclick = function(){ refreshBtn.disabled=true; refreshBtn.textContent='…'; vscode.postMessage({ type:'refresh' }); };

    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (m.type === 'runs') {
        refreshBtn.disabled=false; refreshBtn.textContent='↻ Refresh';
        if (m.outputLogGroup) outputLogGroup = m.outputLogGroup;
        if (m.errorLogGroup) errorLogGroup = m.errorLogGroup;
        render(m.rows || []);
      } else if (m.type === 'error') {
        refreshBtn.disabled=false; refreshBtn.textContent='↻ Refresh';
        showError(m.message || 'Unknown error');
      }
    });

    vscode.postMessage({ type:'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializeRun(run: JobRun): {
  id: string;
  state: string;
  started?: string;
  durationSec?: number;
  errorMessage?: string;
} {
  return {
    id: run.Id ?? "(unknown)",
    state: run.JobRunState ?? "UNKNOWN",
    started: run.StartedOn ? run.StartedOn.toISOString() : undefined,
    durationSec: run.ExecutionTime,
    errorMessage: run.ErrorMessage,
  };
}
