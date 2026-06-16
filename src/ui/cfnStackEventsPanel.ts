import * as vscode from "vscode";
import {
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/** How often to poll DescribeStackEvents while a stack is mid-flight. */
const POLL_INTERVAL_MS = 5_000;
/** Pull up to this many initial events on first open (most recent first). */
const INITIAL_EVENT_LIMIT = 200;
/** AWS terminal stack statuses — when reached, the poll auto-stops. */
const TERMINAL_STACK_STATUSES = new Set<string>([
  "CREATE_COMPLETE",
  "CREATE_FAILED",
  "DELETE_COMPLETE",
  "DELETE_FAILED",
  "UPDATE_COMPLETE",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_COMPLETE",
  "UPDATE_ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
  "IMPORT_ROLLBACK_FAILED",
]);

/**
 * Live-tailing CloudFormation stack events panel.
 *
 * On open, fetches the most recent events for the stack and starts a 5-second
 * poll loop. The loop auto-stops when the stack reaches a terminal status
 * (CREATE_COMPLETE, UPDATE_COMPLETE, ROLLBACK_COMPLETE, *_FAILED, etc.) or
 * when the user clicks the Stop button. Closing the panel also stops the
 * poll, so we never leave a timer running.
 *
 * Read-only — calls `DescribeStackEvents` + `DescribeStacks` only.
 */
export class CfnStackEventsPanel {
  private static panels = new Map<string, CfnStackEventsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly stackName: string;

  /** Active poll handle. `undefined` when idle or stopped. */
  private pollTimer?: ReturnType<typeof setTimeout>;
  /** Latest event id we've delivered — used to dedupe across polls. */
  private latestEventId?: string;
  /** Current known stack status; used to decide when to stop polling. */
  private currentStatus?: string;
  /** When true, the user (or panel disposal) asked us to stop. */
  private stopped = false;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.stackName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewCfnStackEvents",
      `Events: ${this.stackName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      this.stopPolling();
      CfnStackEventsPanel.panels.delete(resource.arn);
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          await this.bootstrap();
        } else if (msg.type === "stopPolling") {
          this.stopPolling();
          void this.panel.webview.postMessage({ type: "pollState", polling: false, reason: "user-stopped" });
        } else if (msg.type === "resumePolling") {
          this.stopped = false;
          await this.pollOnce();
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = CfnStackEventsPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new CfnStackEventsPanel(platform, resource);
    CfnStackEventsPanel.panels.set(resource.arn, instance);
  }

  // ─── AWS calls ──────────────────────────────────────────────────────────

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  /** First call after `ready`: fetch initial event window + start poll if mid-flight. */
  private async bootstrap(): Promise<void> {
    await this.pollOnce({ initial: true });
  }

  /**
   * One poll cycle: refresh stack status, fetch any new events since
   * `latestEventId`, push them to the webview, and schedule the next tick
   * unless the stack is in a terminal state.
   */
  private async pollOnce(opts: { initial?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    const scope = await this.resolveScope();
    if (!scope) return;

    let client;
    try {
      client = await this.platform.awsClientFactory.cloudformation(scope);
    } catch (err: unknown) {
      this.postError(`Failed to create CloudFormation client: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Stack status — if it has changed, surface that even with no new events.
    try {
      const stackResp = await this.platform.scheduler.run("cloudformation", "DescribeStacks", () =>
        client.send(new DescribeStacksCommand({ StackName: this.stackName }))
      );
      const status = stackResp.Stacks?.[0]?.StackStatus;
      const reason = stackResp.Stacks?.[0]?.StackStatusReason;
      if (status && status !== this.currentStatus) {
        this.currentStatus = status;
        void this.panel.webview.postMessage({
          type: "statusUpdate",
          status,
          reason,
          terminal: TERMINAL_STACK_STATUSES.has(status),
        });
      }
    } catch (err: unknown) {
      // Stack may have been deleted mid-flight — that's a terminal state too.
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist/i.test(msg)) {
        this.currentStatus = "DELETE_COMPLETE";
        void this.panel.webview.postMessage({
          type: "statusUpdate",
          status: "DELETE_COMPLETE",
          reason: "Stack has been deleted",
          terminal: true,
        });
      } else {
        this.postError(`DescribeStacks failed: ${msg}`);
      }
    }

    // Events. We page through (most-recent-first), stopping at the previously-seen id.
    const newEvents: StackEvent[] = [];
    let nextToken: string | undefined;
    let stopPaging = false;
    let firstPage = true;
    try {
      do {
        const resp = await this.platform.scheduler.run("cloudformation", "DescribeStackEvents", () =>
          client.send(new DescribeStackEventsCommand({ StackName: this.stackName, NextToken: nextToken }))
        );
        for (const evt of resp.StackEvents ?? []) {
          if (this.latestEventId && evt.EventId === this.latestEventId) {
            stopPaging = true;
            break;
          }
          newEvents.push(evt);
          // Initial fetch is capped to avoid dumping 10k historical events into the panel.
          if (opts.initial && newEvents.length >= INITIAL_EVENT_LIMIT) {
            stopPaging = true;
            break;
          }
        }
        nextToken = resp.NextToken;
        firstPage = false;
        if (stopPaging) break;
        // Without a prior id (very first call), don't page indefinitely — one
        // page is enough to seed `latestEventId` and we'll catch up on subsequent ticks.
        if (!this.latestEventId && !opts.initial) break;
      } while (nextToken);
      void firstPage;
    } catch (err: unknown) {
      this.postError(`DescribeStackEvents failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (newEvents.length > 0) {
      // Track the most-recent id (first in the API response, since it's reverse-chronological).
      this.latestEventId = newEvents[0].EventId ?? this.latestEventId;
      // Send to webview in chronological order (oldest first) so they append naturally.
      const payload = [...newEvents].reverse().map(serializeEvent);
      void this.panel.webview.postMessage({
        type: "events",
        events: payload,
        initial: !!opts.initial,
      });
    } else if (opts.initial) {
      // No events at all (shouldn't happen for a real stack, but defensive).
      void this.panel.webview.postMessage({ type: "events", events: [], initial: true });
    }

    // Schedule next tick unless terminal.
    const isTerminal = !!this.currentStatus && TERMINAL_STACK_STATUSES.has(this.currentStatus);
    if (isTerminal) {
      void this.panel.webview.postMessage({ type: "pollState", polling: false, reason: "terminal" });
      this.stopPolling();
      return;
    }
    void this.panel.webview.postMessage({ type: "pollState", polling: true });
    this.pollTimer = setTimeout(() => {
      void this.pollOnce().catch((err) => this.postError(String(err)));
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.stopped = true;
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  // ─── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.stackName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>CFN Events: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .cfn-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .cfn-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .cfn-title .icon { color: #1d4ed8; font-size: 20px; }
    .cfn-meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; align-items: center; }
    .cfn-meta .label { font-weight: 600; }
    .arn-row { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; word-break: break-all; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
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

    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 11px;
      text-transform: uppercase; letter-spacing: .5px;
    }
    .status-pill.green { background: #dcfce7; color: #166534; }
    .status-pill.yellow { background: #fef3c7; color: #92400e; }
    .status-pill.red { background: #fee2e2; color: #991b1b; }
    .status-pill.gray { background: #e5e7eb; color: #374151; }
    .status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .status-pill .dot.pulse { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: .3; }
    }

    .content { flex: 1; overflow: auto; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    table.events {
      border-collapse: collapse; font-size: 12px; width: 100%; min-width: max-content;
    }
    table.events thead th {
      background: var(--surface-2); position: sticky; top: 0; z-index: 1;
      border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left;
      font-weight: 700; color: var(--text); white-space: nowrap;
      font-size: 11px; text-transform: uppercase; letter-spacing: .3px;
    }
    table.events tbody td {
      padding: 6px 10px; border-bottom: 1px solid var(--border);
      vertical-align: top;
      color: var(--text);
    }
    table.events tbody tr.new-row { animation: highlightNew 2s ease-out; }
    @keyframes highlightNew {
      0% { background: #fef3c7; }
      100% { background: transparent; }
    }
    table.events td.ts { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); white-space: nowrap; }
    table.events td.lid { font-family: 'SF Mono', 'Fira Code', monospace; font-weight: 600; white-space: nowrap; }
    table.events td.rtype { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); white-space: nowrap; }
    table.events td.status { white-space: nowrap; }
    table.events td.reason { color: var(--muted); max-width: 600px; word-wrap: break-word; }

    .event-status-pill {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .3px;
    }
    .event-status-pill.green { background: #dcfce7; color: #166534; }
    .event-status-pill.yellow { background: #fef3c7; color: #92400e; }
    .event-status-pill.red { background: #fee2e2; color: #991b1b; }
    .event-status-pill.gray { background: #e5e7eb; color: #374151; }

    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none;
    }
  </style>
</head>
<body>
  <div class="cfn-header">
    <div class="cfn-title">
      <span class="icon">\u{1F4CB}</span>
      <span>${name}</span>
      <span id="status-pill" class="status-pill gray"><span class="dot"></span><span id="status-text">loading…</span></span>
    </div>
    <div class="cfn-meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Polling:</span> every ${POLL_INTERVAL_MS / 1000}s while in-flight</span>
      <span id="status-reason" style="display:none;"><span class="label">Reason:</span> <span id="status-reason-text"></span></span>
    </div>
    <div class="arn-row">${arn}</div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <button class="btn danger" id="stop-btn">⏹ Stop polling</button>
    <button class="btn ghost" id="resume-btn" style="display:none;">▶ Resume polling</button>
    <span style="flex:1;"></span>
    <span id="event-count" style="font-size:11px;color:var(--muted);">0 events</span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F4CB}</div>
      <div>Loading recent events…</div>
    </div>
    <table class="events" id="events-table" style="display:none;">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Logical ID</th>
          <th>Resource type</th>
          <th>Status</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody id="events-body"></tbody>
    </table>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var stopBtn = document.getElementById('stop-btn');
    var resumeBtn = document.getElementById('resume-btn');
    var statusPill = document.getElementById('status-pill');
    var statusText = document.getElementById('status-text');
    var statusReasonRow = document.getElementById('status-reason');
    var statusReasonText = document.getElementById('status-reason-text');
    var eventCountEl = document.getElementById('event-count');
    var emptyEl = document.getElementById('empty');
    var table = document.getElementById('events-table');
    var tbody = document.getElementById('events-body');
    var errorBanner = document.getElementById('error-banner');
    var totalEvents = 0;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      setTimeout(function(){ errorBanner.style.display = 'none'; }, 8000);
    }

    function statusColorClass(status) {
      var s = String(status || '').toUpperCase();
      if (s.endsWith('_COMPLETE') && !s.includes('ROLLBACK') && !s.includes('FAILED')) return 'green';
      if (s.endsWith('_FAILED')) return 'red';
      if (s.includes('ROLLBACK')) return 'red';
      if (s.endsWith('_IN_PROGRESS')) return 'yellow';
      if (s === 'DELETE_COMPLETE') return 'gray';
      return 'gray';
    }

    function fmtTs(iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
      } catch(_) { return String(iso); }
    }

    function renderEvents(events, isInitial) {
      if (!events || events.length === 0) {
        if (isInitial) {
          emptyEl.style.display = 'flex';
          emptyEl.querySelector('div:nth-child(2)').textContent = 'No events found for this stack.';
        }
        return;
      }
      emptyEl.style.display = 'none';
      table.style.display = '';

      var html = '';
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var cls = statusColorClass(e.status);
        var newCls = isInitial ? '' : ' class="new-row"';
        html += '<tr' + newCls + '>' +
          '<td class="ts">' + esc(fmtTs(e.timestamp)) + '</td>' +
          '<td class="lid">' + esc(e.logicalId || '') + '</td>' +
          '<td class="rtype">' + esc(e.resourceType || '') + '</td>' +
          '<td class="status"><span class="event-status-pill ' + cls + '">' + esc(e.status || '') + '</span></td>' +
          '<td class="reason">' + esc(e.reason || '') + '</td>' +
          '</tr>';
      }
      // Newest at top: prepend if streaming, replace if initial.
      if (isInitial) {
        tbody.innerHTML = html;
      } else {
        tbody.insertAdjacentHTML('afterbegin', html);
      }
      totalEvents += events.length;
      eventCountEl.textContent = totalEvents + ' event' + (totalEvents === 1 ? '' : 's');
    }

    function applyStatus(status, reason, terminal) {
      statusText.textContent = status;
      statusPill.className = 'status-pill ' + statusColorClass(status);
      var dot = statusPill.querySelector('.dot');
      if (dot) dot.className = 'dot' + (terminal ? '' : ' pulse');
      if (reason) {
        statusReasonText.textContent = reason;
        statusReasonRow.style.display = '';
      } else {
        statusReasonRow.style.display = 'none';
      }
    }

    stopBtn.onclick = function() {
      vscode.postMessage({ type: 'stopPolling' });
    };
    resumeBtn.onclick = function() {
      vscode.postMessage({ type: 'resumePolling' });
      resumeBtn.style.display = 'none';
      stopBtn.style.display = '';
    };

    window.addEventListener('message', function(ev) {
      var m = ev.data;
      if (m.type === 'statusUpdate') {
        applyStatus(m.status, m.reason, !!m.terminal);
      } else if (m.type === 'events') {
        renderEvents(m.events, !!m.initial);
      } else if (m.type === 'pollState') {
        if (m.polling) {
          stopBtn.style.display = '';
          resumeBtn.style.display = 'none';
        } else {
          stopBtn.style.display = 'none';
          resumeBtn.style.display = '';
        }
      } else if (m.type === 'error') {
        showError(m.message || 'Unknown error');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function serializeEvent(evt: StackEvent): {
  timestamp?: string;
  logicalId?: string;
  resourceType?: string;
  status?: string;
  reason?: string;
} {
  return {
    timestamp: evt.Timestamp instanceof Date ? evt.Timestamp.toISOString() : (evt.Timestamp ? String(evt.Timestamp) : undefined),
    logicalId: evt.LogicalResourceId,
    resourceType: evt.ResourceType,
    status: evt.ResourceStatus,
    reason: evt.ResourceStatusReason,
  };
}
