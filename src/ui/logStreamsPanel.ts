import * as vscode from "vscode";
import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  type LogGroup,
  type LogStream,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { buildLogGroupArn, makeStubResource } from "../core/resourceUtils";
import {
  generateNonce,
  escapeHtml,
  escapeJsonForEmbed,
  buildCsp,
  BASE_STYLES,
  AWS_ICONS,
  DEFAULT_ICON,
} from "../views/webviewToolkit";
import { CloudWatchLogsPanel } from "./lambdaLogsPanel";

interface StreamRow {
  name: string;
  lastEventTime?: number;
  firstEventTime?: number;
  storedBytes?: number;
}

interface ContentMatch {
  timestamp?: number;
  streamName: string;
  message: string;
}

const LOG_GROUP_HUB_PAGE = 50;

/** Same source labels as the logs discoverer; used in the log-group list UI only. */
function logGroupSourceFromName(name: string): string {
  if (name.startsWith("/aws/lambda/")) { return "Lambda"; }
  if (name.startsWith("/aws/apigateway/") || name.startsWith("API-Gateway-Execution-Logs_")) { return "API Gateway"; }
  if (name.startsWith("/aws/ecs/") || name.startsWith("/ecs/")) { return "ECS"; }
  if (name.startsWith("/aws/codebuild/")) { return "CodeBuild"; }
  if (name.startsWith("/aws/rds/") || name.startsWith("/aws/rds-")) { return "RDS"; }
  if (name.startsWith("/aws/redshift/")) { return "Redshift"; }
  if (name.startsWith("/aws/eks/")) { return "EKS"; }
  if (name.startsWith("/aws/vpc/") || name.startsWith("/aws/vpc-flow-logs/")) { return "VPC"; }
  if (name.startsWith("/aws/vendedlogs/")) { return "Vended Logs"; }
  if (name.startsWith("/aws/events/")) { return "EventBridge"; }
  if (name.startsWith("/aws/states/") || name.startsWith("/aws/vendedlogs/states/")) { return "Step Functions"; }
  if (name.startsWith("/aws/cloudtrail/") || name.toLowerCase().includes("cloudtrail")) { return "CloudTrail"; }
  if (name.startsWith("/aws/route53/") || name.startsWith("/aws/route53-")) { return "Route 53"; }
  if (name.startsWith("/aws/")) { return "AWS Service"; }
  return "Custom";
}

/**
 * Picks a log group in an account/region (prefix search, paginate), then
 * reuses {@link LogStreamsPanel} to browse streams and search. Used for
 * ECS where group names are not known in advance; lives here with the rest
 * of the CloudWatch Logs webview code.
 */
export class LogGroupListPanel {
  private static instances = new Map<string, LogGroupListPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly platform: CloudViewPlatform;
  private readonly accountId: string;
  private readonly region: string;
  private readonly anchorName: string;
  private readonly cacheKey: string;
  private groups: LogGroup[] = [];
  private nextToken: string | undefined;
  private prefix = "";

  private constructor(platform: CloudViewPlatform, anchor: ResourceNode) {
    this.platform = platform;
    this.accountId = anchor.accountId;
    this.region = anchor.region;
    this.anchorName = anchor.name || anchor.id;
    this.cacheKey = `${this.accountId}::${this.region}`;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLogGroupHub",
      `CloudWatch Logs · ${this.region}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => LogGroupListPanel.instances.delete(this.cacheKey));
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "search" && typeof msg.prefix === "string") {
          this.prefix = msg.prefix.trim();
          await this.loadFirstPage();
        } else if (msg.type === "loadMore") {
          await this.loadNextPage();
        } else if (msg.type === "openGroup" && typeof msg.name === "string") {
          const resource = this.stubLogGroupResource(msg.name);
          await LogStreamsPanel.open(this.platform, resource);
        } else if (msg.type === "refresh") {
          await this.loadFirstPage();
        }
      } catch (err) {
        this.hubPostError(err);
      }
    });
    this.panel.iconPath = vscode.Uri.joinPath(
      this.platform.extensionContext.extensionUri,
      "media",
      "icons",
      "logs.svg",
    );
    this.panel.webview.html = this.buildHubHtml();
    void this.loadFirstPage();
  }

  public static async open(platform: CloudViewPlatform, anchor: ResourceNode): Promise<void> {
    const key = `${anchor.accountId}::${anchor.region}`;
    const existing = LogGroupListPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.loadFirstPage();
      return;
    }
    const inst = new LogGroupListPanel(platform, anchor);
    LogGroupListPanel.instances.set(key, inst);
  }

  private stubLogGroupResource(name: string): ResourceNode {
    return makeStubResource({
      arn: buildLogGroupArn(this.region, this.accountId, name),
      id: name,
      type: ResourceTypes.logGroup,
      service: "logs",
      accountId: this.accountId,
      region: this.region,
      name,
      rawJson: { LogGroupName: name, Source: logGroupSourceFromName(name) },
    });
  }

  private async hubClient() {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.accountId);
    if (!profileName) {
      throw new Error("No AWS profile found for this account.");
    }
    const scope = { profileName, accountId: this.accountId, region: this.region };
    return this.platform.awsClientFactory.cloudwatchLogs(scope);
  }

  private async loadFirstPage(): Promise<void> {
    this.nextToken = undefined;
    this.groups = [];
    this.hubListUpdate(true);
    const client = await this.hubClient();
    const response = await this.platform.scheduler.run("logs", "DescribeLogGroups", () =>
      client.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: this.prefix || undefined,
          limit: LOG_GROUP_HUB_PAGE,
        }),
      ),
    );
    this.groups = response.logGroups ?? [];
    this.nextToken = response.nextToken;
    this.hubListUpdate(false);
  }

  private async loadNextPage(): Promise<void> {
    if (!this.nextToken) {
      return;
    }
    const client = await this.hubClient();
    const response = await this.platform.scheduler.run("logs", "DescribeLogGroups", () =>
      client.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: this.prefix || undefined,
          limit: LOG_GROUP_HUB_PAGE,
          nextToken: this.nextToken,
        }),
      ),
    );
    this.groups = this.groups.concat(response.logGroups ?? []);
    this.nextToken = response.nextToken;
    this.hubListUpdate(false);
  }

  private hubListUpdate(loading: boolean): void {
    if (loading) {
      void this.panel.webview.postMessage({ type: "hubList", loading: true });
      return;
    }
    void this.panel.webview.postMessage({
      type: "hubList",
      loading: false,
      groups: this.groups
        .map((g) => ({
          name: g.logGroupName ?? "",
          source: logGroupSourceFromName(g.logGroupName ?? ""),
          retention: g.retentionInDays,
          storedBytes: g.storedBytes,
        }))
        .filter((g) => g.name),
      hasMore: Boolean(this.nextToken),
      prefix: this.prefix,
    });
  }

  private hubPostError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    void this.panel.webview.postMessage({ type: "error", error: message });
  }

  private buildHubHtml(): string {
    const n = generateNonce();
    const icon = AWS_ICONS["logs"] || DEFAULT_ICON;
    const hint = `Find a log group, then browse streams and search. Opened for ${escapeHtml(this.anchorName)}.`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>CloudWatch Logs</title>
<style>
${BASE_STYLES}
.hub-hint { padding: 8px 24px; font-size: 11px; color: var(--muted); background: var(--surface-2); border-bottom: 1px solid var(--border); line-height: 1.4; }
.hub-hint code { background: var(--surface); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; font-size: 10.5px; }
.logs-pill { display: inline-block; padding: 1px 6px; border-radius: 99px; background: var(--surface); border: 1px solid var(--border); font-size: 9px; font-weight: 600; color: var(--muted); text-transform: uppercase; }
.group-path { font-family: ui-monospace, 'SF Mono', monospace; font-size: 11.5px; }
.btn-browse { background: var(--accent); color: #fff; border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }
.btn-browse:hover { filter: brightness(1.05); }
.btn-more { background: var(--surface-2); color: var(--text); border: 1px solid var(--border-2); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 11px; cursor: pointer; }
#load-more { margin: 10px 24px 20px; }
</style>
</head>
<body>
<div class="cv-header">
  <div class="cv-header-top">
    <div class="cv-service-icon">${icon}</div>
    <div class="cv-title-group">
      <div class="cv-service-title">CloudWatch Logs</div>
      <div class="cv-service-subtitle">
        <span><span class="label">Region:</span> ${escapeHtml(this.region)}</span>
        <span><span class="label">Account:</span> ${escapeHtml(this.accountId)}</span>
      </div>
    </div>
    <div class="cv-header-actions">
      <button class="cv-btn" id="btn-refresh" type="button" title="Reload list">↻ Refresh</button>
    </div>
  </div>
</div>
<div class="hub-hint">${hint} Use a <strong>name prefix</strong> (e.g. <code>/ecs</code>) to narrow, then <strong>Browse</strong> to open this extension’s stream viewer.</div>
<div class="cv-toolbar">
  <div class="cv-search-wrap" style="flex:1;max-width:none;">
    <input class="cv-search" id="prefix" type="text" placeholder="Log group name prefix (optional)…" autofocus>
  </div>
  <button class="btn-browse" type="button" id="btn-search">Search</button>
</div>
<div class="scroll-wrap" style="overflow:auto;flex:1;min-height:0;">
  <table class="cv-table" id="g-table">
    <thead><tr>
      <th style="width:52%">Log group</th>
      <th style="width:14%">Source</th>
      <th style="width:12%">Retention</th>
      <th style="width:12%">Size</th>
      <th style="width:10%"></th>
    </tr></thead>
    <tbody id="g-body">
      <tr><td colspan="5" class="cv-empty"><span class="cv-empty-icon">…</span>Loading log groups…</td></tr>
    </tbody>
  </table>
  <div id="load-wrap" style="display:none;">
    <button class="btn-more" type="button" id="load-more">Load more</button>
  </div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtBytes(b) {
  if (b == null || b === 0) return '<span class="cell-dash">—</span>';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}
function retLabel(d) { if (d == null) return 'Never expire'; if (d === 1) return '1d'; return d + 'd'; }
function renderHub(m) {
  var tbody = document.getElementById('g-body');
  var loadWrap = document.getElementById('load-wrap');
  var moreBtn = document.getElementById('load-more');
  var prefix = document.getElementById('prefix');
  if (m.prefix !== undefined) prefix.value = m.prefix;
  if (m.loading) {
    tbody.innerHTML = '<tr><td colspan="5" class="cv-empty"><span class="cv-empty-icon">…</span>Loading log groups…</td></tr>';
    loadWrap.style.display = 'none';
    return;
  }
  var groups = m.groups || [];
  if (groups.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="cv-empty"><span class="cv-empty-icon">∅</span>No log groups for this prefix. Try another prefix or clear it.</td></tr>';
  } else {
    tbody.innerHTML = groups.map(function(g) {
      return '<tr><td class="group-path" title="' + esc(g.name) + '">' + esc(g.name) + '</td>' +
        '<td><span class="logs-pill">' + esc(g.source || 'Custom') + '</span></td>' +
        '<td class="cell-num">' + esc(retLabel(g.retention)) + '</td>' +
        '<td class="cell-num">' + fmtBytes(g.storedBytes) + '</td>' +
        '<td><button class="btn-browse" type="button" data-name="' + esc(g.name) + '">Browse</button></td></tr>';
    }).join('');
    tbody.querySelectorAll('button[data-name]').forEach(function(btn) {
      btn.addEventListener('click', function() { vscode.postMessage({ type: 'openGroup', name: btn.getAttribute('data-name') }); });
    });
  }
  loadWrap.style.display = m.hasMore ? 'block' : 'none';
  if (m.hasMore) { moreBtn.disabled = false; moreBtn.textContent = 'Load more'; }
}
document.getElementById('btn-search').addEventListener('click', function() {
  document.getElementById('g-body').innerHTML = '<tr><td colspan="5" class="cv-empty"><span class="cv-empty-icon">…</span>Loading…</td></tr>';
  vscode.postMessage({ type: 'search', prefix: document.getElementById('prefix').value || '' });
});
document.getElementById('prefix').addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('btn-search').click(); });
document.getElementById('btn-refresh').addEventListener('click', function() { vscode.postMessage({ type: 'refresh' }); });
document.getElementById('load-more').addEventListener('click', function() {
  var btn = document.getElementById('load-more');
  btn.disabled = true; btn.textContent = 'Loading…';
  vscode.postMessage({ type: 'loadMore' });
});
window.addEventListener('message', function(ev) {
  var m = ev.data;
  if (m.type === 'hubList') { renderHub(m); }
  if (m.type === 'error') {
    document.getElementById('g-body').innerHTML = '<tr><td colspan="5" class="cv-empty" style="color:#b91c1c">⚠ ' + esc(m.error) + '</td></tr>';
    document.getElementById('load-wrap').style.display = 'none';
    var b = document.getElementById('load-more');
    if (b) { b.disabled = false; b.textContent = 'Load more'; }
  }
});
</script>
</body>
</html>`;
  }
}

/**
 * Panel for exploring a single CloudWatch log group:
 *
 *   1. Stream browser — shows the most recent log streams with last-event
 *      timestamps and sizes. Clicking a stream opens the read-only tail
 *      viewer ({@link CloudWatchLogsPanel}).
 *   2. Content search — runs a server-side `FilterLogEvents` across the
 *      whole group with a CloudWatch filter-pattern and a time window.
 *      Results land in-panel with the originating stream name so the user
 *      can jump straight to the full stream.
 *
 * The panel is keyed by the log group's ARN and is reused if re-opened.
 * For ECS, {@link LogGroupListPanel} lists groups first, then calls
 * {@link LogStreamsPanel.open} for the chosen group.
 */
export class LogStreamsPanel {
  private static panels = new Map<string, LogStreamsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly logGroupName: string;
  private streams: StreamRow[] = [];

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.logGroupName = (resource.rawJson.LogGroupName as string) ?? resource.name ?? resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLogStreams",
      `Logs: ${shortGroupName(this.logGroupName)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => LogStreamsPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "refresh") {
          await this.loadStreams();
        } else if (msg.type === "openStream" && typeof msg.stream === "string") {
          await CloudWatchLogsPanel.show(
            this.platform,
            this.resource,
            this.logGroupName,
            shortGroupName(this.logGroupName),
            msg.stream,
          );
        } else if (msg.type === "searchContent" && typeof msg.pattern === "string") {
          await this.searchContent(msg.pattern, Number(msg.minutes) || 60);
        }
      } catch (err) {
        this.postError(err);
      }
    });

    this.panel.iconPath = vscode.Uri.joinPath(this.platform.extensionContext.extensionUri, "media", "icons", "logs.svg");
    this.panel.webview.html = this.buildHtml();
    void this.loadStreams();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = LogStreamsPanel.panels.get(resource.arn);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new LogStreamsPanel(platform, resource);
    LogStreamsPanel.panels.set(resource.arn, instance);
  }

  private async loadStreams(): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);

    // Only show streams with activity in the last 30 days. CloudWatch doesn't
    // support a server-side date filter on DescribeLogStreams, so we order by
    // LastEventTime descending and stop paginating as soon as we cross the
    // 30-day cutoff. This avoids walking thousands of stale streams for chatty
    // groups that never clean up.
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - THIRTY_DAYS_MS;
    const MAX_PAGES = 10; // hard cap: ~500 recent streams is more than any UI needs

    const all: LogStream[] = [];
    let nextToken: string | undefined;
    let stopped = false;
    let pages = 0;
    do {
      const response = await this.platform.scheduler.run("logs", "DescribeLogStreams", () =>
        client.send(new DescribeLogStreamsCommand({
          logGroupName: this.logGroupName,
          orderBy: "LastEventTime",
          descending: true,
          limit: 50,
          nextToken,
        }))
      );
      const page = response.logStreams ?? [];
      for (const s of page) {
        // `lastEventTimestamp` can be undefined for brand-new streams with no
        // events yet — treat those as "recent" (they just haven't written).
        const last = s.lastEventTimestamp;
        if (last !== undefined && last < cutoffMs) {
          stopped = true;
          break;
        }
        all.push(s);
      }
      nextToken = response.nextToken;
      pages++;
      if (stopped || pages >= MAX_PAGES) break;
    } while (nextToken);

    this.streams = all.map((s) => ({
      name: s.logStreamName ?? "",
      lastEventTime: s.lastEventTimestamp,
      firstEventTime: s.firstEventTimestamp,
      storedBytes: s.storedBytes,
    })).filter((s) => s.name);

    void this.panel.webview.postMessage({
      type: "streamsUpdate",
      streams: this.streams,
      windowDays: 30,
    });
  }

  private async searchContent(pattern: string, minutes: number): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.cloudwatchLogs(scope);
    const startTime = Date.now() - minutes * 60 * 1000;

    const response = await this.platform.scheduler.run("logs", "FilterLogEvents", () =>
      client.send(new FilterLogEventsCommand({
        logGroupName: this.logGroupName,
        filterPattern: pattern || undefined,
        startTime,
        limit: 200,
      }))
    );

    const matches: ContentMatch[] = (response.events ?? []).map((e) => ({
      timestamp: e.timestamp,
      streamName: e.logStreamName ?? "",
      message: e.message ?? "",
    }));

    void this.panel.webview.postMessage({
      type: "searchResult",
      pattern,
      minutes,
      matches,
    });
  }

  private postError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    void this.panel.webview.postMessage({ type: "error", error: message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const icon = AWS_ICONS["logs"] || DEFAULT_ICON;
    const group = escapeHtml(this.logGroupName);
    const retention = this.resource.rawJson.RetentionInDays as number | undefined;
    const storedBytes = (this.resource.rawJson.StoredBytes as number | undefined) ?? 0;
    const source = escapeHtml((this.resource.rawJson.Source as string | undefined) ?? "Custom");
    const retentionLabel = retention ? `${retention}d retention` : "Never expire";
    const sizeLabel = formatBytes(storedBytes);
    const initialStreams = escapeJsonForEmbed(this.streams);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>Logs: ${group}</title>
<style>
${BASE_STYLES}
.logs-group-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 24px; background: var(--surface-2);
  border-bottom: 1px solid var(--border); font-size: 11px;
  color: var(--muted); font-family: ui-monospace, 'SF Mono', monospace;
}
.logs-group-bar code {
  color: var(--accent); font-weight: 600; user-select: all;
  background: var(--surface); padding: 2px 8px; border-radius: 4px;
  border: 1px solid var(--border); font-size: 11px;
}
.logs-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 99px;
  background: var(--surface); border: 1px solid var(--border);
  font-size: 10px; font-weight: 500; color: var(--muted);
  text-transform: uppercase; letter-spacing: .04em;
}
.logs-mode-tabs { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; gap: 2px; flex-shrink: 0; }
.logs-mode-tab {
  padding: 11px 14px; cursor: pointer; font-size: 12.5px; font-weight: 500;
  color: var(--muted); border-bottom: 2px solid transparent;
  user-select: none; transition: color .12s, border-color .12s; position: relative; top: 1px;
  display: inline-flex; align-items: center; gap: 7px;
}
.logs-mode-tab:hover { color: var(--text); }
.logs-mode-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.logs-panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.logs-panel.active { display: flex; }
.stream-row-btn {
  background: transparent; border: none; color: var(--accent);
  cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600;
  padding: 0; text-align: left;
}
.stream-row-btn:hover { text-decoration: underline; }
.stream-name {
  font-family: ui-monospace, 'SF Mono', monospace; font-size: 11.5px;
  color: var(--text); max-width: 520px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-block; vertical-align: middle;
}
.search-row { display: flex; gap: 8px; padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--border); align-items: center; }
.search-row .cv-search { max-width: none; flex: 1; }
.search-row select, .search-row input[type="number"] {
  background: var(--surface-2); border: 1px solid var(--border-2); color: var(--text);
  padding: 6px 10px; border-radius: var(--radius-sm); font-size: 12px;
  font-family: inherit;
}
.search-row input[type="number"] { width: 80px; }
.search-row button.primary {
  padding: 6px 14px; background: var(--accent); color: #fff; border: 1px solid var(--accent);
  border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; font-weight: 600;
  font-family: inherit; transition: all .12s;
}
.search-row button.primary:hover { filter: brightness(1.05); }
.search-row button.primary:disabled { opacity: .5; cursor: wait; }
.search-hint {
  padding: 8px 24px; font-size: 11px; color: var(--muted); background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.search-hint code {
  background: var(--surface); border: 1px solid var(--border); border-radius: 3px;
  padding: 1px 4px; font-size: 10.5px; color: var(--text-2);
  font-family: ui-monospace, 'SF Mono', monospace;
}
.match-line { display: flex; gap: 12px; padding: 6px 24px; border-bottom: 1px solid var(--border); font-family: ui-monospace, 'SF Mono', monospace; font-size: 11.5px; line-height: 1.5; }
.match-line:hover { background: var(--surface-2); }
.match-ts { color: var(--muted); flex-shrink: 0; white-space: nowrap; min-width: 170px; }
.match-stream {
  flex-shrink: 0; min-width: 160px; max-width: 220px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: transparent; border: none; cursor: pointer;
  color: var(--accent); font-family: inherit; font-size: 11px; font-weight: 600;
  text-align: left; padding: 0;
}
.match-stream:hover { text-decoration: underline; }
.match-msg { flex: 1; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.match-msg.hl-error { color: #b91c1c; }
.match-msg.hl-warn { color: #a16207; }
.empty-state {
  text-align: center; padding: 60px 20px;
  color: var(--light); font-size: 13px;
}
.empty-state-icon { font-size: 28px; margin-bottom: 10px; opacity: .6; }
.scroll-wrap { flex: 1; overflow-y: auto; background: var(--surface); }
.logs-section-title {
  padding: 14px 24px 8px;
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  background: var(--surface);
  border-bottom: 1px dashed var(--border);
}
.logs-section-title h2 {
  margin: 0; font-size: 13px; font-weight: 600;
  color: var(--text); letter-spacing: -0.01em;
  display: inline-flex; align-items: center; gap: 6px;
}
.logs-section-title p { margin: 0; font-size: 11px; color: var(--muted); }
.logs-30d-hint {
  font-weight: 600; color: var(--accent);
  background: var(--accent-soft); padding: 1px 7px; border-radius: 4px;
  white-space: nowrap;
}
</style>
</head>
<body>
<div class="cv-header">
  <div class="cv-header-top">
    <div class="cv-service-icon">${icon}</div>
    <div class="cv-title-group">
      <div class="cv-service-title">${escapeHtml(shortGroupName(this.logGroupName))}</div>
      <div class="cv-service-subtitle">
        <span>CloudWatch Logs</span>
        <span class="cv-sep">\u2022</span>
        <span>${escapeHtml(this.resource.region)}</span>
        <span class="cv-sep">\u2022</span>
        <span>${escapeHtml(this.resource.accountId)}</span>
      </div>
    </div>
    <div class="cv-header-actions">
      <button class="cv-btn" id="refresh" title="Refresh streams">&#8635; Refresh</button>
    </div>
  </div>
</div>
<!--
  <div class="logs-group-bar" style="background: var(--surface-2); border-bottom: 1px solid var(--border);">

    <code>${group}</code>
    <span class="logs-pill">${source}</span>
    <span class="logs-pill">${escapeHtml(retentionLabel)}</span>
    <span class="logs-pill">${escapeHtml(sizeLabel)}</span>
  </div>
-->
<div class="logs-mode-tabs">
  <div class="logs-mode-tab active" data-mode="streams">\uD83D\uDCDC Streams</div>
  <div class="logs-mode-tab" data-mode="search">\uD83D\uDD0D Search content</div>
</div>

<!-- Streams mode -->
<div id="streams-panel" class="logs-panel active">
  <div class="logs-section-title">
    <h2>\uD83D\uDCDC Log streams in this group</h2>
    <p>Most recent first \u00B7 <span class="logs-30d-hint">Last 30 days only</span> \u00B7 Click a stream to tail its events</p>
  </div>
  <div class="cv-toolbar">
    <div class="cv-search-wrap">
      <input class="cv-search" id="stream-filter" type="text" placeholder="Filter streams by name\u2026" autofocus>
    </div>
    <span class="cv-count" id="stream-count"></span>
  </div>
  <div class="scroll-wrap">
    <table class="cv-table" id="stream-table">
      <thead><tr>
        <th style="width:55%">Stream Name</th>
        <th>Last Event</th>
        <th>First Event</th>
        <th>Size</th>
      </tr></thead>
      <tbody id="stream-tbody">
        <tr><td colspan="4" class="cv-empty"><span class="cv-empty-icon">\u2026</span>Loading streams\u2026</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Content search mode -->
<div id="search-panel" class="logs-panel">
  <div class="logs-section-title">
    <h2>\uD83D\uDD0D Search events in this group</h2>
    <p>Runs FilterLogEvents across every stream. Click a result's stream to open it</p>
  </div>
  <div class="search-row">
    <input class="cv-search" id="content-pattern" type="text" placeholder='CloudWatch filter pattern, e.g. ERROR or "timed out"'>
    <select id="content-minutes" title="Time window">
      <option value="5">Last 5 min</option>
      <option value="15">Last 15 min</option>
      <option value="60" selected>Last 1 hour</option>
      <option value="360">Last 6 hours</option>
      <option value="1440">Last 24 hours</option>
      <option value="10080">Last 7 days</option>
    </select>
    <button class="primary" id="content-search-btn">Search</button>
  </div>
  <div class="scroll-wrap" id="match-list">
    <div class="empty-state">
      <div class="empty-state-icon">\uD83D\uDD0D</div>
      <div>Enter a filter pattern and click Search.</div>
    </div>
  </div>
</div>

<script nonce="${n}">
const vscode = acquireVsCodeApi();
let STREAMS = ${initialStreams};

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function fmtRel(ts) {
  if (!ts) return '<span class="cell-dash">\u2014</span>';
  const now = Date.now();
  const diff = (now - ts) / 1000;
  let rel;
  if (diff < 60) rel = Math.floor(diff) + 's ago';
  else if (diff < 3600) rel = Math.floor(diff/60) + 'm ago';
  else if (diff < 86400) rel = Math.floor(diff/3600) + 'h ago';
  else if (diff < 2592000) rel = Math.floor(diff/86400) + 'd ago';
  else rel = new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
  const abs = new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return '<span title="' + abs + '">' + rel + '</span>';
}

function fmtTs(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

function fmtBytes(b) {
  if (!b || b === 0) return '<span class="cell-dash">\u2014</span>';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return '<span class="cell-num">' + (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i] + '</span>';
}

function classifyMsg(m) {
  if (/error|exception|traceback|fatal|failed/i.test(m)) return 'hl-error';
  if (/warn/i.test(m)) return 'hl-warn';
  return '';
}

// ── Mode tabs ────────────────────────────────────────────────────────────
document.querySelectorAll('.logs-mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.logs-mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.logs-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(tab.dataset.mode + '-panel').classList.add('active');
  });
});

// ── Streams ──────────────────────────────────────────────────────────────
const streamFilter = document.getElementById('stream-filter');
const streamTbody = document.getElementById('stream-tbody');
const streamCount = document.getElementById('stream-count');

function renderStreams() {
  const q = streamFilter.value.toLowerCase();
  const filtered = q ? STREAMS.filter(s => s.name.toLowerCase().indexOf(q) !== -1) : STREAMS;
  streamCount.textContent = filtered.length + ' of ' + STREAMS.length + ' streams';

  if (filtered.length === 0) {
    const hint = q ? 'Try a different filter.' : 'No streams have emitted events yet.';
    streamTbody.innerHTML = '<tr><td colspan="4" class="cv-empty"><span class="cv-empty-icon">\u2601</span>No streams found<br><span style="font-size:11px;font-weight:400;">' + esc(hint) + '</span></td></tr>';
    return;
  }

  streamTbody.innerHTML = filtered.map(s =>
    '<tr>' +
      '<td><button class="stream-row-btn" data-stream="' + esc(s.name) + '" title="Open this stream"><span class="stream-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span></button></td>' +
      '<td>' + fmtRel(s.lastEventTime) + '</td>' +
      '<td>' + fmtRel(s.firstEventTime) + '</td>' +
      '<td>' + fmtBytes(s.storedBytes) + '</td>' +
    '</tr>'
  ).join('');

  streamTbody.querySelectorAll('button[data-stream]').forEach(btn => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openStream', stream: btn.dataset.stream });
    });
  });
}

streamFilter.addEventListener('input', renderStreams);
document.getElementById('refresh').addEventListener('click', () => {
  streamTbody.innerHTML = '<tr><td colspan="4" class="cv-empty"><span class="cv-empty-icon">\u2026</span>Loading streams\u2026</td></tr>';
  vscode.postMessage({ type: 'refresh' });
});

renderStreams();

// ── Content search ───────────────────────────────────────────────────────
const searchBtn = document.getElementById('content-search-btn');
const patternInput = document.getElementById('content-pattern');
const minutesSelect = document.getElementById('content-minutes');
const matchList = document.getElementById('match-list');

function doSearch() {
  const pattern = patternInput.value;
  const minutes = parseInt(minutesSelect.value) || 60;
  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching\u2026';
  matchList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\u2026</div><div>Running <code>FilterLogEvents</code>\u2026</div></div>';
  vscode.postMessage({ type: 'searchContent', pattern, minutes });
}

searchBtn.addEventListener('click', doSearch);
patternInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

function renderMatches(pattern, minutes, matches) {
  searchBtn.disabled = false;
  searchBtn.textContent = 'Search';

  if (matches.length === 0) {
    matchList.innerHTML = '<div class="empty-state">' +
      '<div class="empty-state-icon">\uD83D\uDD0E</div>' +
      '<div>No matches for <code>' + esc(pattern || '(empty)') + '</code> in the last ' + minutes + ' min.</div>' +
      '<div class="cv-empty-hint" style="margin-top:6px;">Try broadening the time window or adjusting the pattern.</div>' +
    '</div>';
    return;
  }

  const header = '<div class="search-hint" style="border-bottom:1px solid var(--border);">' +
    '<strong>' + matches.length + '</strong> match' + (matches.length === 1 ? '' : 'es') +
    ' for <code>' + esc(pattern || '(all events)') + '</code> in the last ' + minutes + ' min' +
  '</div>';

  const lines = matches.map(m =>
    '<div class="match-line">' +
      '<span class="match-ts">' + fmtTs(m.timestamp) + '</span>' +
      '<button class="match-stream" data-stream="' + esc(m.streamName) + '" title="Open this stream">' + esc(m.streamName) + '</button>' +
      '<span class="match-msg ' + classifyMsg(m.message) + '">' + esc(m.message) + '</span>' +
    '</div>'
  ).join('');

  matchList.innerHTML = header + lines;
  matchList.querySelectorAll('button[data-stream]').forEach(btn => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openStream', stream: btn.dataset.stream });
    });
  });
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'streamsUpdate') {
    STREAMS = m.streams || [];
    renderStreams();
  } else if (m.type === 'searchResult') {
    renderMatches(m.pattern, m.minutes, m.matches || []);
  } else if (m.type === 'error') {
    matchList.innerHTML = '<div class="empty-state"><div class="empty-state-icon" style="color:#b91c1c">\u26A0</div><div style="color:#b91c1c">' + esc(m.error) + '</div></div>';
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
    streamTbody.innerHTML = '<tr><td colspan="4" class="cv-empty"><span class="cv-empty-icon" style="color:#b91c1c">\u26A0</span><span style="color:#b91c1c">' + esc(m.error) + '</span></td></tr>';
  }
});
</script>
</body>
</html>`;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) { return "0 B"; }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Shorten log group paths that blow out the panel title. Keeps the final
 * two path segments (enough to disambiguate `/aws/lambda/myFn`) prefixed
 * with an ellipsis when truncation actually happens.
 */
function shortGroupName(name: string): string {
  if (name.length <= 60) { return name; }
  const parts = name.split("/").filter(Boolean);
  if (parts.length <= 2) { return name; }
  return `\u2026/${parts.slice(-2).join("/")}`;
}
