import * as vscode from "vscode";
import {
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

interface LogLine {
  timestamp?: number;
  message: string;
}

export class CloudWatchLogsPanel {
  private static panels = new Map<string, CloudWatchLogsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private lines: LogLine[] = [];
  private streamName = "";
  private allStreams: string[] = [];

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
    private readonly displayLabel: string,
    private readonly logGroupName: string
  ) {
    // Active column so the logs viewer replaces the triggering panel as a
    // tab rather than splitting the editor.
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLogs",
      `Logs: ${displayLabel}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => CloudWatchLogsPanel.panels.delete(this.panelKey()));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "switchStream") {
        await this.loadStream(msg.stream);
      } else if (msg.type === "search") {
        try {
          await this.searchLogs(
            msg.pattern ?? "",
            msg.minutes || 60,
            typeof msg.stream === "string" && msg.stream.length > 0 ? msg.stream : undefined,
          );
        } catch (err) {
          this.platform.logger.error(`CloudWatch search failed for ${this.logGroupName}`, err);
          this.panel.webview.postMessage({ type: "searchError", message: String((err as Error).message ?? err) });
        }
      }
    });
  }

  private panelKey(): string {
    return `${this.resource.arn}::${this.logGroupName}`;
  }

  /**
   * Open logs for any resource given an explicit CloudWatch log group name.
   * Pass `initialStream` to jump directly to a specific stream; otherwise
   * the most recent stream in the group is loaded.
   */
  public static async show(
    platform: CloudViewPlatform,
    resource: ResourceNode,
    logGroupName: string,
    displayLabel?: string,
    initialStream?: string,
  ): Promise<void> {
    const label = displayLabel ?? resource.name ?? resource.id;
    const key = `${resource.arn}::${logGroupName}`;

    const existing = CloudWatchLogsPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (initialStream) {
        await existing.loadStream(initialStream);
      } else {
        await existing.loadStreams();
      }
      return;
    }

    const instance = new CloudWatchLogsPanel(platform, resource, label, logGroupName);
    CloudWatchLogsPanel.panels.set(key, instance);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading logs for ${label}…` },
      async () => {
        try {
          if (initialStream) {
            // Populate the full stream list in the background so the
            // dropdown still works, but render the requested stream first.
            await instance.loadStreamsQuiet();
            await instance.loadStream(initialStream);
          } else {
            await instance.loadStreams();
          }
        } catch (error) {
          platform.logger.error(`Failed to load logs for ${label} (${logGroupName})`, error);
          void vscode.window.showWarningMessage(
            `Could not load logs for ${label}. The log group "${logGroupName}" may not exist yet.`
          );
        }
      }
    );
  }

  /** Populate `allStreams` without rendering or auto-selecting a stream. */
  private async loadStreamsQuiet(): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) { return; }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);

    const response = await this.platform.scheduler.run("logs", "DescribeLogStreams", () =>
      client.send(
        new DescribeLogStreamsCommand({
          logGroupName: this.logGroupName,
          orderBy: "LastEventTime",
          descending: true,
          limit: 50,
        })
      )
    );

    this.allStreams = (response.logStreams ?? [])
      .map((s) => s.logStreamName!)
      .filter(Boolean);
  }

  /**
   * Resolve `/aws/lambda/…` for a Lambda function and open the log viewer.
   * ECS and other services use `LogGroupListPanel` or pass an explicit group via {@link show}.
   */
  public static async showForResource(
    platform: CloudViewPlatform,
    resource: ResourceNode,
  ): Promise<void> {
    const logGroup = resolveLambdaLogGroup(resource);
    if (!logGroup) {
      void vscode.window.showWarningMessage(
        `Not a Lambda function — no /aws/lambda/… log group to open (${resource.type}).`
      );
      return;
    }
    await CloudWatchLogsPanel.show(platform, resource, logGroup);
  }

  private async loadStreams(): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);

    const response = await this.platform.scheduler.run("logs", "DescribeLogStreams", () =>
      client.send(
        new DescribeLogStreamsCommand({
          logGroupName: this.logGroupName,
          orderBy: "LastEventTime",
          descending: true,
          limit: 25,
        })
      )
    );

    this.allStreams = (response.logStreams ?? [])
      .map((s) => s.logStreamName!)
      .filter(Boolean);

    if (this.allStreams.length > 0) {
      await this.loadStream(this.allStreams[0]);
    } else {
      this.renderPanel();
    }
  }

  private async loadStream(streamName: string): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);

    const response = await this.platform.scheduler.run("logs", "GetLogEvents", () =>
      client.send(
        new GetLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: streamName,
          startFromHead: false,
          limit: 200,
        })
      )
    );

    this.streamName = streamName;
    this.lines = (response.events ?? []).map((e) => ({
      timestamp: e.timestamp,
      message: e.message ?? "",
    }));

    this.renderPanel();
  }

  private async searchLogs(pattern: string, minutes: number, streamFilter?: string): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);
    const startTime = Date.now() - minutes * 60 * 1000;

    const response = await this.platform.scheduler.run("logs", "FilterLogEvents", () =>
      client.send(
        new FilterLogEventsCommand({
          logGroupName: this.logGroupName,
          filterPattern: pattern || undefined,
          logStreamNames: streamFilter ? [streamFilter] : undefined,
          startTime,
          limit: 200,
        })
      )
    );

    const scopeLabel = streamFilter ? `${shortStream(streamFilter)}` : "all streams";
    const patternLabel = pattern ? `"${pattern}"` : "recent";
    this.streamName = `search: ${patternLabel} in ${scopeLabel} (last ${minutes}m)`;
    this.lines = (response.events ?? []).map((e) => ({
      timestamp: e.timestamp,
      message: e.message ?? "",
    }));

    this.panel.webview.postMessage({
      type: "update",
      lines: this.lines,
      streamName: this.streamName,
    });
  }

  private renderPanel(): void {
    this.panel.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const n = generateNonce();
    const logsJson = JSON.stringify(this.lines).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    const streamsJson = JSON.stringify(this.allStreams).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    const streamSafe = escapeHtml(this.streamName);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Logs: ${escapeHtml(this.displayLabel)}</title>
  <style>
    ${BASE_STYLES}
    body { font-family: var(--vscode-editor-font-family, 'Menlo', 'Courier New', monospace); font-size: 12px; display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
    .log-group-badge { padding: 6px 12px; font-size: 11px; color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--border-2); user-select: all; }
    .log-group-badge code { color: var(--accent); font-weight: 600; }
    #log-container { flex: 1; overflow-y: auto; }
    .log-line { display: flex; padding: 2px 12px; line-height: 1.6; border-bottom: 1px solid transparent; }
    .log-line:hover { background: var(--surface-2); }
    .ts { color: #608b4e; flex-shrink: 0; margin-right: 12px; user-select: none; }
    .msg { white-space: pre-wrap; word-break: break-all; flex: 1; }
    .msg.error  { color: #f48771; }
    .msg.warn   { color: #dcdcaa; }
    .msg.start  { color: #9cdcfe; }
    .msg.report { color: #c586c0; }
    .msg.init   { color: #4fc1ff; }
    #empty { display: none; padding: 40px; text-align: center; color: var(--light); }
    .log-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; background: var(--surface);
      border-bottom: 1px solid var(--border-2);
      flex-wrap: wrap;
    }
    .log-toolbar select, .log-toolbar input[type="text"] {
      background: var(--surface-2); border: 1px solid var(--border-2);
      color: var(--text); padding: 5px 8px; border-radius: var(--radius-sm);
      font-size: 11.5px; font-family: inherit; min-width: 0;
    }
    .log-toolbar #stream-select { flex: 0 1 220px; max-width: 260px; }
    .log-toolbar #search-pattern { flex: 1 1 200px; min-width: 140px; }
    .log-toolbar #search-minutes { flex: 0 0 auto; width: auto; }
    .log-toolbar button.primary {
      padding: 5px 14px; background: var(--accent); color: #fff;
      border: 1px solid var(--accent); border-radius: var(--radius-sm);
      cursor: pointer; font-size: 11.5px; font-weight: 600; font-family: inherit;
      transition: filter .12s;
    }
    .log-toolbar button.primary:hover { filter: brightness(1.08); }
    .log-toolbar button.primary:disabled { opacity: .5; cursor: wait; }
    .log-toolbar .cv-count { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .log-events-head { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--text); background: var(--surface-2); border-bottom: 1px solid var(--border-2); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .log-events-head span { font-size: 10px; font-weight: 400; color: var(--muted); }
  </style>
</head>
<body>
  <div class="log-group-badge">Log Group: <code>${escapeHtml(this.logGroupName)}</code></div>
  <div class="log-toolbar">
    <select id="stream-select" title="Log stream \u2014 pick one or All streams to search the whole group"></select>
    <input id="search-pattern" type="text" placeholder='Filter pattern \u2014 e.g. ERROR, timeout, "exact phrase"'>
    <select id="search-minutes" title="Time window">
      <option value="5">Last 5 min</option>
      <option value="15">Last 15 min</option>
      <option value="60" selected>Last 1 hour</option>
      <option value="360">Last 6 hours</option>
      <option value="1440">Last 24 hours</option>
      <option value="10080">Last 7 days</option>
    </select>
    <button class="primary" id="search-btn" type="button">Search</button>
    <span class="cv-count" id="count"></span>
  </div>
  <div class="log-events-head">
    <span>Log events</span>
    <span id="log-events-context">Tail view \u00B7 newest chunk of the selected stream</span>
  </div>
  <div id="log-container"></div>
  <div id="empty">No log entries match your filter.</div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var allLines  = ${logsJson};
    var allStreams = ${streamsJson};
    var activeStream = ${JSON.stringify(streamSafe)};

    var streamSelect = document.getElementById('stream-select');
    var patternInput = document.getElementById('search-pattern');
    var minutesSelect = document.getElementById('search-minutes');
    var searchBtn = document.getElementById('search-btn');
    var countEl   = document.getElementById('count');
    var container = document.getElementById('log-container');
    var emptyEl   = document.getElementById('empty');
    var contextEl = document.getElementById('log-events-context');

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function syncEventsContext() {
      if (!contextEl) return;
      var sn = String(activeStream || '');
      if (sn.indexOf('search:') === 0) {
        contextEl.textContent = 'Search results \u00B7 ' + sn.replace(/^search:\\s*/, '');
      } else if (sn) {
        contextEl.textContent = 'Tail view \u00B7 ' + sn;
      } else {
        contextEl.textContent = 'Tail view \u00B7 newest chunk of the selected stream';
      }
    }

    function buildStreamSelect() {
      var opts = ['<option value="">All streams (search group)</option>'];
      for (var i = 0; i < allStreams.length; i++) {
        var s = allStreams[i];
        opts.push('<option value="' + esc(s) + '"' + (s === activeStream ? ' selected' : '') + '>' + esc(s.slice(-60)) + '</option>');
      }
      streamSelect.innerHTML = opts.join('');
    }
    buildStreamSelect();
    syncEventsContext();

    function classify(msg) {
      if (/error|exception|traceback|failed/i.test(msg)) return 'error';
      if (/warn/i.test(msg)) return 'warn';
      if (/^START /.test(msg)) return 'start';
      if (/^REPORT /.test(msg)) return 'report';
      if (/^INIT_START/.test(msg)) return 'init';
      return '';
    }

    function fmt(ts) {
      if (!ts) return '\\u2014';
      return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
    }

    function render(lines) {
      if (!lines.length) {
        container.innerHTML = '';
        emptyEl.style.display = 'block';
        countEl.textContent = '0 lines';
        return;
      }
      emptyEl.style.display = 'none';
      countEl.textContent = lines.length + ' lines';
      container.innerHTML = lines.map(function(l) {
        var cls = classify(l.message);
        return '<div class="log-line"><span class="ts">' + fmt(l.timestamp) + '</span><span class="msg ' + cls + '">' + esc(l.message) + '</span></div>';
      }).join('');
    }

    // Unified Search: uses the stream selector + pattern + time window in one call.
    //  - Stream = "" (All streams)    -> FilterLogEvents across the whole group
    //  - Stream picked + no pattern   -> tail that stream (GetLogEvents)
    //  - Stream picked + pattern      -> FilterLogEvents scoped to that stream
    function doSearch() {
      var stream = streamSelect.value;
      var pattern = patternInput.value.trim();
      var minutes = parseInt(minutesSelect.value, 10) || 60;

      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching\u2026';

      if (stream && !pattern) {
        vscode.postMessage({ type: 'switchStream', stream: stream });
      } else {
        vscode.postMessage({ type: 'search', pattern: pattern, minutes: minutes, stream: stream });
      }
    }

    searchBtn.addEventListener('click', doSearch);
    patternInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearch(); });
    streamSelect.addEventListener('change', function() {
      // Picking a specific stream with no pattern behaves like the old quick-switch.
      if (streamSelect.value && !patternInput.value.trim()) {
        searchBtn.disabled = true;
        searchBtn.textContent = 'Loading\u2026';
        vscode.postMessage({ type: 'switchStream', stream: streamSelect.value });
      }
    });

    render(allLines);

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'update') {
        allLines = msg.lines;
        if (msg.streamName) activeStream = msg.streamName;
        if (msg.streams) { allStreams = msg.streams; buildStreamSelect(); }
        render(allLines);
        syncEventsContext();
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      } else if (msg.type === 'searchError') {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
        container.innerHTML = '<div style="padding:20px;color:#f48771;">Search failed: ' + esc(msg.message) + '</div>';
        emptyEl.style.display = 'none';
        countEl.textContent = 'error';
      }
    });
  </script>
</body>
</html>`;
  }
}

// Keep backward-compatible alias
export const LambdaLogsPanel = CloudWatchLogsPanel;

/** Truncate a stream name for display in the "search: … in <stream>" context string. */
function shortStream(name: string): string {
  return name.length > 40 ? `\u2026${name.slice(-40)}` : name;
}

/**
 * Conventional log group for a Lambda: `/aws/lambda/<functionName>`.
 */
function resolveLambdaLogGroup(resource: ResourceNode): string | undefined {
  if (resource.type !== ResourceTypes.lambdaFunction) {
    return undefined;
  }
  const name =
    (resource.rawJson.FunctionName as string | undefined) ?? resource.name ?? resource.id;
  return `/aws/lambda/${name}`;
}
