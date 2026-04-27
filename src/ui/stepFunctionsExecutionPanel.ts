import * as vscode from "vscode";
import {
  StartExecutionCommand,
  ListExecutionsCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  StopExecutionCommand,
  type ExecutionStatus,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsScope, ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Panel for starting executions of an AWS Step Functions state machine and
 * inspecting their history.
 *
 * The panel supports three operations:
 *  - {@link startExecution} — starts a new execution with a user-supplied JSON
 *    payload (via `StartExecutionCommand`) and refreshes the executions list.
 *  - {@link listExecutions} — fetches the 25 most recent executions via
 *    `ListExecutionsCommand`, used on initial load and after every start/stop.
 *  - {@link describeExecution} — when the user clicks an execution row, fetches
 *    its status/input/output with `DescribeExecutionCommand` and the events
 *    timeline with `GetExecutionHistoryCommand`. These events are rendered as
 *    a structured log in the details pane.
 *
 * Panels are keyed by the state machine ARN so repeated opens re-use the
 * existing panel instead of stacking new tabs.
 */
export class StepFunctionsExecutionPanel {
  private static panels = new Map<string, StepFunctionsExecutionPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly stateMachineArn: string;
  private readonly stateMachineName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.stateMachineArn = resource.arn;
    this.stateMachineName = resource.name || resource.id;

    // Open in the currently active column (typically the service detail panel's
    // column) so the execution UI replaces the triggering tab instead of
    // splitting the editor side-by-side.
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewSfnExecution",
      `Step Functions: ${this.stateMachineName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => StepFunctionsExecutionPanel.panels.delete(this.stateMachineArn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "startExecution") {
          await this.startExecution(typeof msg.payload === "string" ? msg.payload : "{}", typeof msg.name === "string" ? msg.name : undefined);
        } else if (msg.type === "listExecutions") {
          await this.listExecutions();
        } else if (msg.type === "describeExecution" && typeof msg.arn === "string") {
          await this.describeExecution(msg.arn);
        } else if (msg.type === "stopExecution" && typeof msg.arn === "string") {
          await this.stopExecution(msg.arn);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void this.panel.webview.postMessage({ type: "error", error: message });
      }
    });

    this.panel.webview.html = this.buildHtml();
    void this.listExecutions();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = StepFunctionsExecutionPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new StepFunctionsExecutionPanel(platform, resource);
    StepFunctionsExecutionPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<AwsScope | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      void this.panel.webview.postMessage({ type: "error", error: "No AWS profile resolved for this account." });
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async startExecution(payload: string, customName?: string): Promise<void> {
    const trimmed = payload.trim();
    if (trimmed.length > 0) {
      try {
        JSON.parse(trimmed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void this.panel.webview.postMessage({ type: "startResult", error: `Invalid JSON payload: ${message}` });
        return;
      }
    }

    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);
    const executionName = customName?.trim() || `run-${Date.now()}`;

    try {
      const response = await this.platform.scheduler.run("sfn", "StartExecution", () =>
        client.send(new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          input: trimmed.length > 0 ? trimmed : "{}",
          name: executionName,
        }))
      );
      void this.panel.webview.postMessage({
        type: "startResult",
        executionArn: response.executionArn,
        startDate: response.startDate?.toISOString(),
      });
      await this.listExecutions();
      if (response.executionArn) {
        await this.describeExecution(response.executionArn);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "startResult", error: message });
    }
  }

  private async listExecutions(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);
    try {
      const response = await this.platform.scheduler.run("sfn", "ListExecutions", () =>
        client.send(new ListExecutionsCommand({ stateMachineArn: this.stateMachineArn, maxResults: 25 }))
      );
      const executions = (response.executions ?? []).map((e) => ({
        executionArn: e.executionArn,
        name: e.name,
        status: e.status as ExecutionStatus | undefined,
        startDate: e.startDate?.toISOString(),
        stopDate: e.stopDate?.toISOString(),
      }));
      void this.panel.webview.postMessage({ type: "executionsList", executions });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "executionsList", executions: [], error: message });
    }
  }

  private async stopExecution(executionArn: string): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);
    try {
      await this.platform.scheduler.run("sfn", "StopExecution", () =>
        client.send(new StopExecutionCommand({ executionArn }))
      );
      await this.listExecutions();
      await this.describeExecution(executionArn);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "error", error: message });
    }
  }

  private async describeExecution(executionArn: string): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);

    try {
      const [describe, history] = await Promise.all([
        this.platform.scheduler.run("sfn", "DescribeExecution", () =>
          client.send(new DescribeExecutionCommand({ executionArn }))
        ),
        this.collectHistory(executionArn),
      ]);

      const durationMs = describe.startDate && describe.stopDate
        ? describe.stopDate.getTime() - describe.startDate.getTime()
        : undefined;

      void this.panel.webview.postMessage({
        type: "executionDetail",
        executionArn,
        name: describe.name,
        status: describe.status,
        startDate: describe.startDate?.toISOString(),
        stopDate: describe.stopDate?.toISOString(),
        durationMs,
        input: this.prettyJsonString(describe.input),
        output: this.prettyJsonString(describe.output),
        error: describe.error,
        cause: describe.cause,
        events: history.map((e) => this.simplifyEvent(e)),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "executionDetail", executionArn, error: message, events: [] });
    }
  }

  private async collectHistory(executionArn: string): Promise<HistoryEvent[]> {
    const scope = await this.resolveScope();
    if (!scope) return [];
    const client = await this.platform.awsClientFactory.sfn(scope);
    const events: HistoryEvent[] = [];
    let nextToken: string | undefined;
    // Cap at ~500 events to keep the webview responsive on long-running executions.
    for (let i = 0; i < 5; i++) {
      const response = await this.platform.scheduler.run("sfn", "GetExecutionHistory", () =>
        client.send(new GetExecutionHistoryCommand({
          executionArn,
          maxResults: 100,
          nextToken,
          includeExecutionData: true,
        }))
      );
      if (response.events) events.push(...response.events);
      nextToken = response.nextToken;
      if (!nextToken) break;
    }
    return events;
  }

  private simplifyEvent(event: HistoryEvent): Record<string, unknown> {
    const detailBlocks: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key === "id" || key === "previousEventId" || key === "timestamp" || key === "type") continue;
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if ("name" in obj) detailBlocks.name = String(obj.name);
        if ("resource" in obj) detailBlocks.resource = String(obj.resource);
        if ("resourceType" in obj) detailBlocks.resourceType = String(obj.resourceType);
        if ("input" in obj) detailBlocks.input = this.prettyJsonString(obj.input as string | undefined);
        if ("output" in obj) detailBlocks.output = this.prettyJsonString(obj.output as string | undefined);
        if ("error" in obj) detailBlocks.error = String(obj.error);
        if ("cause" in obj) detailBlocks.cause = String(obj.cause);
      }
    }
    return {
      id: event.id,
      previousEventId: event.previousEventId,
      type: event.type,
      timestamp: event.timestamp?.toISOString(),
      ...detailBlocks,
    };
  }

  private prettyJsonString(value: string | undefined): string | undefined {
    if (!value) return value;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.stateMachineName);
    const smType = escapeHtml(String(this.resource.rawJson.StateMachineType ?? "STANDARD"));
    const region = escapeHtml(this.resource.region);
    const arn = escapeHtml(this.stateMachineArn);
    const roleArn = escapeHtml(String(this.resource.rawJson.RoleArn ?? "\u2014"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Step Functions: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .sfn-header {
      background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 14px 20px; flex-shrink: 0;
    }
    .sfn-title { font-size: 17px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .sfn-title .fn-icon { color: #C925D1; font-size: 18px; }
    .sfn-meta { display: flex; gap: 14px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .sfn-meta .label { font-weight: 600; }
    .sfn-arn { font-family: ui-monospace, 'SF Mono', monospace; font-size: 10px; color: var(--light); margin-top: 4px; word-break: break-all; }

    .sfn-body { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; overflow: hidden; }

    .sfn-main { display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--border); }
    .sfn-payload-section { padding: 12px 18px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sfn-section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
    .sfn-payload-editor {
      width: 100%; height: 110px;
      font-family: ui-monospace, 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.5;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 10px 12px; border-radius: var(--radius); resize: vertical; tab-size: 2;
    }
    .sfn-payload-editor:focus { outline: none; border-color: #C925D1; box-shadow: 0 0 0 3px rgba(201,37,209,.18); }

    .sfn-controls { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
    .sfn-name-input {
      flex: 1; padding: 6px 10px; font-size: 12px;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text); border-radius: var(--radius-sm);
      font-family: ui-monospace, 'SF Mono', monospace;
    }
    .sfn-start-btn {
      background: #C925D1; color: white; border: none;
      padding: 7px 18px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all .15s;
    }
    .sfn-start-btn:hover { background: #a61dab; }
    .sfn-start-btn:disabled { opacity: .5; cursor: not-allowed; }
    .sfn-start-btn .spinner { display: none; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: sfn-spin .6s linear infinite; }
    .sfn-start-btn.loading .spinner { display: inline-block; }
    @keyframes sfn-spin { to { transform: rotate(360deg); } }

    .sfn-detail-section { flex: 1; overflow: auto; padding: 14px 18px; }
    .sfn-detail-meta { display: flex; gap: 14px; font-size: 11px; color: var(--muted); margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
    .sfn-detail-meta .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
    .sfn-badge-success { background: #d1fae5; color: #065f46; }
    .sfn-badge-running { background: #fef3c7; color: #92400e; }
    .sfn-badge-failed  { background: #fee2e2; color: #991b1b; }
    .sfn-badge-neutral { background: #e2e8f0; color: #475569; }

    .sfn-json {
      font-family: ui-monospace, 'SF Mono', 'Fira Code', monospace; font-size: 11.5px; line-height: 1.55;
      background: var(--surface-2); border: 1px solid var(--border);
      padding: 10px 12px; border-radius: var(--radius-sm);
      white-space: pre-wrap; word-break: break-all; color: var(--text);
      max-height: 240px; overflow: auto; margin-bottom: 14px;
    }
    .sfn-error-block { background: #fef2f2; border-color: #fecaca; color: #991b1b; }

    .sfn-events { display: flex; flex-direction: column; gap: 6px; }
    .sfn-event {
      background: var(--surface); border: 1px solid var(--border);
      border-left: 3px solid #cbd5e1; padding: 8px 10px; border-radius: var(--radius-sm); font-size: 11px;
    }
    .sfn-event.ok { border-left-color: #10b981; }
    .sfn-event.err { border-left-color: #ef4444; background: #fef2f2; }
    .sfn-event.task { border-left-color: #C925D1; }
    .sfn-event.exec { border-left-color: #3b82f6; }
    .sfn-event-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .sfn-event-type { font-weight: 600; color: var(--text); font-family: ui-monospace, monospace; font-size: 11px; }
    .sfn-event-time { color: var(--light); font-size: 10px; font-family: ui-monospace, monospace; white-space: nowrap; }
    .sfn-event-name { color: var(--muted); margin-top: 3px; font-family: ui-monospace, monospace; }
    .sfn-event-detail { margin-top: 6px; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--text-2); white-space: pre-wrap; word-break: break-all; background: var(--surface-2); padding: 6px 8px; border-radius: 4px; max-height: 160px; overflow: auto; }

    .sfn-sidebar { overflow: hidden; display: flex; flex-direction: column; background: var(--surface-2); }
    .sfn-sidebar-head { padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
    .sfn-sidebar-title { font-size: 12px; font-weight: 700; color: var(--text); }
    .sfn-refresh { background: transparent; border: 1px solid var(--border-2); color: var(--muted); padding: 3px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; }
    .sfn-refresh:hover { background: var(--surface); color: var(--text); }
    .sfn-exec-list { flex: 1; overflow: auto; }
    .sfn-exec-row {
      padding: 10px 14px; border-bottom: 1px solid var(--border);
      cursor: pointer; transition: background .12s;
    }
    .sfn-exec-row:hover { background: var(--surface); }
    .sfn-exec-row.active { background: var(--surface); border-left: 3px solid #C925D1; padding-left: 11px; }
    .sfn-exec-name { font-size: 11.5px; font-family: ui-monospace, monospace; color: var(--text); word-break: break-all; margin-bottom: 4px; }
    .sfn-exec-meta { display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: var(--muted); }

    .sfn-empty { padding: 30px 20px; text-align: center; color: var(--light); font-size: 12px; }

    .sfn-stop-btn { background: transparent; border: 1px solid #b91c1c; color: #b91c1c; padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; margin-left: auto; }
    .sfn-stop-btn:hover { background: #fef2f2; }
  </style>
</head>
<body>
  <div class="sfn-header">
    <div class="sfn-title"><span class="fn-icon">&#10144;</span><span>${name}</span></div>
    <div class="sfn-meta">
      <span><span class="label">Type:</span> ${smType}</span>
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Role:</span> ${roleArn}</span>
    </div>
    <div class="sfn-arn">${arn}</div>
  </div>

  <div class="sfn-body">
    <div class="sfn-main">
      <div class="sfn-payload-section">
        <div class="sfn-section-title">Execution input (JSON)</div>
        <textarea class="sfn-payload-editor" id="sfn-payload" spellcheck="false" placeholder='{\n  "key": "value"\n}'>{}</textarea>
        <div class="sfn-controls">
          <input class="sfn-name-input" id="sfn-exec-name" placeholder="Execution name (optional)" />
          <button class="sfn-start-btn" id="sfn-start">
            <span class="spinner"></span>
            <span class="btn-text">&#9654; Start Execution</span>
          </button>
        </div>
      </div>
      <div class="sfn-detail-section" id="sfn-detail">
        <div class="sfn-empty">Select or start an execution to see its history and output.</div>
      </div>
    </div>

    <div class="sfn-sidebar">
      <div class="sfn-sidebar-head">
        <div class="sfn-sidebar-title">Recent executions</div>
        <button class="sfn-refresh" id="sfn-refresh-list">&#8635; Refresh</button>
      </div>
      <div class="sfn-exec-list" id="sfn-exec-list">
        <div class="sfn-empty">Loading&hellip;</div>
      </div>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var startBtn = document.getElementById('sfn-start');
    var payloadEl = document.getElementById('sfn-payload');
    var nameEl = document.getElementById('sfn-exec-name');
    var listEl = document.getElementById('sfn-exec-list');
    var detailEl = document.getElementById('sfn-detail');
    var selectedExecutionArn = null;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function statusBadgeClass(status) {
      var s = String(status || '').toUpperCase();
      if (s === 'SUCCEEDED') return 'sfn-badge-success';
      if (s === 'RUNNING' || s === 'PENDING_REDRIVE') return 'sfn-badge-running';
      if (s === 'FAILED' || s === 'TIMED_OUT' || s === 'ABORTED') return 'sfn-badge-failed';
      return 'sfn-badge-neutral';
    }

    function fmtRelative(iso) {
      if (!iso) return '\u2014';
      var dt = new Date(iso);
      if (isNaN(dt.getTime())) return iso;
      var diff = (Date.now() - dt.getTime()) / 1000;
      if (diff < 60) return Math.floor(diff) + 's ago';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    }

    function fmtDuration(ms) {
      if (ms == null) return '\u2014';
      if (ms < 1000) return ms + ' ms';
      var s = ms / 1000;
      if (s < 60) return s.toFixed(2) + 's';
      var m = Math.floor(s / 60); s = s % 60;
      return m + 'm ' + s.toFixed(0) + 's';
    }

    function renderExecutionsList(executions, error) {
      if (error) { listEl.innerHTML = '<div class="sfn-empty" style="color:#b91c1c;">' + esc(error) + '</div>'; return; }
      if (!executions || executions.length === 0) { listEl.innerHTML = '<div class="sfn-empty">No executions yet.</div>'; return; }
      listEl.innerHTML = executions.map(function(e) {
        var cls = selectedExecutionArn === e.executionArn ? 'sfn-exec-row active' : 'sfn-exec-row';
        return '<div class="' + cls + '" data-arn="' + esc(e.executionArn) + '">' +
          '<div class="sfn-exec-name">' + esc(e.name) + '</div>' +
          '<div class="sfn-exec-meta">' +
            '<span class="badge ' + statusBadgeClass(e.status) + '" style="padding:1px 7px;border-radius:10px;font-weight:600;">' + esc(String(e.status || '').toLowerCase()) + '</span>' +
            '<span>' + esc(fmtRelative(e.startDate)) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      listEl.querySelectorAll('.sfn-exec-row').forEach(function(row) {
        row.onclick = function() {
          selectedExecutionArn = row.dataset.arn;
          renderExecutionsList(executions);
          vscode.postMessage({ type: 'describeExecution', arn: selectedExecutionArn });
        };
      });
    }

    function eventClass(type) {
      var t = String(type || '');
      if (/Failed|TimedOut|Aborted/i.test(t)) return 'sfn-event err';
      if (/Succeeded/i.test(t)) return 'sfn-event ok';
      if (/Execution/i.test(t)) return 'sfn-event exec';
      if (/Task|Lambda|Activity|Map|Parallel/i.test(t)) return 'sfn-event task';
      return 'sfn-event';
    }

    function renderEvents(events) {
      if (!events || events.length === 0) return '<div class="sfn-empty">No events.</div>';
      return '<div class="sfn-events">' + events.map(function(ev) {
        var bits = [];
        if (ev.resource) bits.push('Resource: ' + ev.resource);
        if (ev.resourceType) bits.push('Type: ' + ev.resourceType);
        if (ev.name) bits.push('State: ' + ev.name);
        var head = bits.length ? '<div class="sfn-event-name">' + esc(bits.join(' \u00B7 ')) + '</div>' : '';

        var blocks = '';
        if (ev.input)  blocks += '<div class="sfn-event-detail">Input: ' + esc(ev.input) + '</div>';
        if (ev.output) blocks += '<div class="sfn-event-detail">Output: ' + esc(ev.output) + '</div>';
        if (ev.error)  blocks += '<div class="sfn-event-detail">Error: ' + esc(ev.error) + (ev.cause ? '\\nCause: ' + esc(ev.cause) : '') + '</div>';

        return '<div class="' + eventClass(ev.type) + '">' +
          '<div class="sfn-event-head">' +
            '<span class="sfn-event-type">' + esc(ev.type || '') + ' \u00B7 #' + esc(ev.id) + '</span>' +
            '<span class="sfn-event-time">' + esc(ev.timestamp || '') + '</span>' +
          '</div>' + head + blocks + '</div>';
      }).join('') + '</div>';
    }

    function renderDetail(msg) {
      if (msg.error && (!msg.events || msg.events.length === 0)) {
        detailEl.innerHTML = '<div class="sfn-empty" style="color:#b91c1c;">' + esc(msg.error) + '</div>';
        return;
      }

      var html = '';
      html += '<div class="sfn-detail-meta">';
      html += '<span class="badge ' + statusBadgeClass(msg.status) + '">' + esc(String(msg.status || '').toLowerCase()) + '</span>';
      html += '<span><b>Name:</b> ' + esc(msg.name || '') + '</span>';
      html += '<span><b>Started:</b> ' + esc(msg.startDate || '') + '</span>';
      if (msg.stopDate) html += '<span><b>Stopped:</b> ' + esc(msg.stopDate) + '</span>';
      html += '<span><b>Duration:</b> ' + esc(fmtDuration(msg.durationMs)) + '</span>';
      if (String(msg.status || '').toUpperCase() === 'RUNNING') {
        html += '<button class="sfn-stop-btn" data-stop-arn="' + esc(msg.executionArn) + '">Stop execution</button>';
      }
      html += '</div>';

      if (msg.error) {
        html += '<div class="sfn-section-title">Error</div>';
        html += '<div class="sfn-json sfn-error-block">' + esc(msg.error) + (msg.cause ? '\\n\\nCause: ' + esc(msg.cause) : '') + '</div>';
      }

      html += '<div class="sfn-section-title">Input</div>';
      html += '<div class="sfn-json">' + esc(msg.input || '(no input)') + '</div>';

      html += '<div class="sfn-section-title">Output</div>';
      html += '<div class="sfn-json">' + esc(msg.output || '(no output yet)') + '</div>';

      html += '<div class="sfn-section-title">Execution history (' + (msg.events ? msg.events.length : 0) + ' events)</div>';
      html += renderEvents(msg.events);

      detailEl.innerHTML = html;

      var stopBtn = detailEl.querySelector('[data-stop-arn]');
      if (stopBtn) {
        stopBtn.onclick = function() { vscode.postMessage({ type: 'stopExecution', arn: stopBtn.dataset.stopArn }); };
      }
    }

    startBtn.onclick = function() {
      startBtn.classList.add('loading');
      startBtn.disabled = true;
      vscode.postMessage({ type: 'startExecution', payload: payloadEl.value, name: nameEl.value });
    };

    document.getElementById('sfn-refresh-list').onclick = function() { vscode.postMessage({ type: 'listExecutions' }); };

    payloadEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = this.selectionStart;
        var end = this.selectionEnd;
        this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startBtn.click(); }
    });

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'executionsList') { renderExecutionsList(msg.executions, msg.error); return; }
      if (msg.type === 'executionDetail') { renderDetail(msg); return; }
      if (msg.type === 'startResult') {
        startBtn.classList.remove('loading');
        startBtn.disabled = false;
        if (msg.error) {
          detailEl.innerHTML = '<div class="sfn-empty" style="color:#b91c1c;">' + esc(msg.error) + '</div>';
        } else if (msg.executionArn) {
          selectedExecutionArn = msg.executionArn;
          nameEl.value = '';
        }
        return;
      }
      if (msg.type === 'error') {
        detailEl.innerHTML = '<div class="sfn-empty" style="color:#b91c1c;">' + esc(msg.error) + '</div>';
        startBtn.classList.remove('loading');
        startBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  }
}
