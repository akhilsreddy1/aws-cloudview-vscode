import * as vscode from "vscode";
import {
  ListTopicsCommand,
  DescribeTopicCommand,
  DescribeTopicPartitionsCommand,
} from "@aws-sdk/client-kafka";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsScope, ResourceNode } from "../core/contracts";
import {
  generateNonce,
  escapeHtml,
  buildCsp,
  BASE_STYLES,
  AWS_ICONS,
  DEFAULT_ICON,
} from "../views/webviewToolkit";

interface TopicSummary {
  topicName: string;
  partitionCount?: number;
  replicationFactor?: number;
  topicArn?: string;
}

interface PartitionRow {
  partition?: number;
  leader?: number;
  replicas?: number[];
  isr?: number[];
}

/**
 * A dedicated panel for browsing Kafka topics within an MSK cluster.
 *
 * The panel lists all topics via `ListTopicsCommand`, and when a topic is
 * selected, fetches its configuration (`DescribeTopicCommand`) and partition
 * layout (`DescribeTopicPartitionsCommand`).
 */
export class MskTopicsPanel {
  private static panels = new Map<string, MskTopicsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly clusterArn: string;
  private readonly clusterName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.clusterArn = resource.arn;
    this.clusterName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewMskTopics",
      `MSK Topics: ${this.clusterName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => MskTopicsPanel.panels.delete(this.clusterArn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "listTopics") {
          await this.listTopics();
        } else if (msg.type === "describeTopic" && typeof msg.topicName === "string") {
          await this.describeTopic(msg.topicName);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void this.panel.webview.postMessage({ type: "error", error: message });
      }
    });

    this.panel.webview.html = this.buildHtml();
    void this.listTopics();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = MskTopicsPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new MskTopicsPanel(platform, resource);
    MskTopicsPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<AwsScope | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      void this.panel.webview.postMessage({ type: "error", error: "No AWS profile resolved for this account." });
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  // ── List Topics ─────────────────────────────────────────────────────────────
  private async listTopics(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    try {
      const client = await this.platform.awsClientFactory.kafka(scope);
      const topics: TopicSummary[] = [];
      let nextToken: string | undefined;

      do {
        const response = await this.platform.scheduler.run("msk", "ListTopics", () =>
          client.send(new ListTopicsCommand({ ClusterArn: this.clusterArn, NextToken: nextToken, MaxResults: 100 })),
        );
        for (const t of response.Topics ?? []) {
          topics.push({
            topicName: t.TopicName ?? "",
            partitionCount: t.PartitionCount,
            replicationFactor: t.ReplicationFactor,
            topicArn: t.TopicArn,
          });
        }
        nextToken = response.NextToken;
      } while (nextToken);

      topics.sort((a, b) => a.topicName.localeCompare(b.topicName));
      void this.panel.webview.postMessage({ type: "topicsList", topics });
    } catch (err: unknown) {
      void this.panel.webview.postMessage({
        type: "topicsList",
        topics: [],
        error: this.classifyError(err),
      });
    }
  }

  // ── Describe Topic ──────────────────────────────────────────────────────────
  private async describeTopic(topicName: string): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    try {
      const client = await this.platform.awsClientFactory.kafka(scope);

      const [described, partitions] = await Promise.all([
        this.platform.scheduler.run("msk", "DescribeTopic", () =>
          client.send(new DescribeTopicCommand({ ClusterArn: this.clusterArn, TopicName: topicName })),
        ),
        this.collectPartitions(topicName),
      ]);

      const configsDecoded = this.decodeConfigs(described.Configs);

      void this.panel.webview.postMessage({
        type: "topicDetail",
        topicName,
        detail: {
          topicArn: described.TopicArn,
          replicationFactor: described.ReplicationFactor,
          partitionCount: described.PartitionCount,
          status: described.Status ? String(described.Status) : undefined,
          configs: configsDecoded.decoded,
          configsNote: configsDecoded.note,
        },
        partitions,
      });
    } catch (err: unknown) {
      void this.panel.webview.postMessage({
        type: "topicDetail",
        topicName,
        error: this.classifyError(err),
      });
    }
  }

  private async collectPartitions(topicName: string): Promise<PartitionRow[]> {
    const scope = await this.resolveScope();
    if (!scope) return [];
    const client = await this.platform.awsClientFactory.kafka(scope);
    const rows: PartitionRow[] = [];
    let nextToken: string | undefined;

    do {
      const page = await this.platform.scheduler.run("msk", "DescribeTopicPartitions", () =>
        client.send(new DescribeTopicPartitionsCommand({
          ClusterArn: this.clusterArn,
          TopicName: topicName,
          MaxResults: 100,
          NextToken: nextToken,
        })),
      );
      for (const p of page.Partitions ?? []) {
        rows.push({
          partition: p.Partition,
          leader: p.Leader,
          replicas: p.Replicas ?? undefined,
          isr: p.Isr ?? undefined,
        });
      }
      nextToken = page.NextToken;
    } while (nextToken);

    return rows.sort((a, b) => (a.partition ?? 0) - (b.partition ?? 0));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private decodeConfigs(encoded: string | undefined): { decoded: string; note?: string } {
    if (!encoded?.trim()) return { decoded: "(none)" };
    try {
      const buf = Buffer.from(encoded, "base64");
      const decoded = buf.toString("utf8").trimEnd();
      if (decoded.length > 16_384) {
        return { decoded: `${decoded.slice(0, 16_384)}\n… truncated …`, note: `${decoded.length} chars total` };
      }
      return { decoded: decoded || "(empty)", note: decoded.length === 0 ? "Empty after decode." : undefined };
    } catch {
      return { decoded: encoded.slice(0, 480) + (encoded.length > 480 ? "…" : ""), note: "Could not decode; showing raw base64." };
    }
  }

  private isServerless(): boolean {
    const raw = this.resource.rawJson;
    return raw.IsServerless === true || String(raw.ClusterType ?? "").toUpperCase() === "SERVERLESS";
  }

  private classifyError(err: unknown): string {
    const sdkName = typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: string }).name) : "";
    const rawMsg = err instanceof Error ? err.message : String(err);
    const blob = `${sdkName} ${rawMsg}`.toLowerCase();

    if (this.isServerless() && (sdkName === "BadRequestException" || blob.includes("not supported") || blob.includes("serverless"))) {
      return `MSK Serverless may not support Kafka control-plane topic APIs. Use the AWS Console or Kafka tools connected to bootstrap brokers instead. (${sdkName}: ${rawMsg})`;
    }
    if (sdkName === "ForbiddenException" || blob.includes("forbidden")) {
      return `Access denied. Ensure your IAM principal has kafka:ListTopics, kafka:DescribeTopic, kafka:DescribeTopicPartitions on this cluster. (${sdkName}: ${rawMsg})`;
    }
    if (sdkName === "UnauthorizedException") {
      return `Unauthorized. Re-authenticate (aws sso login), verify IAM permissions, then reload profiles. (${sdkName}: ${rawMsg})`;
    }
    return `Kafka API error (${sdkName || "Error"}): ${rawMsg}`;
  }

  // ── HTML ────────────────────────────────────────────────────────────────────
  private buildHtml(): string {
    const n = generateNonce();
    const icon = AWS_ICONS["msk"] || DEFAULT_ICON;
    const cluster = escapeHtml(this.clusterName);
    const region = escapeHtml(this.resource.region);
    const accountId = escapeHtml(this.resource.accountId);
    const kafkaVersion = escapeHtml(String(this.resource.rawJson.KafkaVersion ?? "\u2014"));
    const state = escapeHtml(String(this.resource.rawJson.State ?? "\u2014"));
    const brokers = String(this.resource.rawJson.NumberOfBrokerNodes ?? "\u2014");
    const instanceType = escapeHtml(String(this.resource.rawJson.BrokerInstanceType ?? "\u2014"));
    const clusterType = escapeHtml(String(this.resource.rawJson.ClusterType ?? "PROVISIONED"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>MSK Topics: ${cluster}</title>
<style>
${BASE_STYLES}
body { display:flex; flex-direction:column; height:100vh; overflow:hidden; }

/* ── Layout ── */
.msk-body { flex:1; display:grid; grid-template-columns:300px 1fr; min-height:0; overflow:hidden; }

/* ── Sidebar ── */
.msk-sidebar { display:flex; flex-direction:column; overflow:hidden; border-right:1px solid var(--border); background:var(--surface-2); }
.msk-sidebar-head { padding:10px 14px; border-bottom:1px solid var(--border); flex-shrink:0; }
.msk-sidebar-title { font-size:12px; font-weight:700; color:var(--text); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; }
.msk-search {
  width:100%; padding:6px 10px; font-size:12px; border:1px solid var(--border-2);
  background:var(--surface); color:var(--text); border-radius:var(--radius-sm);
  font-family:inherit;
}
.msk-search:focus { outline:none; border-color:#C7131F; box-shadow:0 0 0 3px rgba(199,19,31,.15); }
.msk-topic-list { flex:1; overflow:auto; }
.msk-topic-row {
  display:flex; align-items:center; gap:8px; padding:8px 14px;
  border-bottom:1px solid var(--border); cursor:pointer; transition:background .08s;
}
.msk-topic-row:hover { background:var(--surface); }
.msk-topic-row.active { background:var(--surface); border-left:3px solid #C7131F; padding-left:11px; }
.msk-topic-name {
  font-size:12px; font-family:ui-monospace,'SF Mono',monospace; color:var(--text);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
}
.msk-topic-badge {
  font-size:9px; font-weight:700; padding:2px 6px; border-radius:99px;
  background:var(--surface-3); color:var(--muted); flex-shrink:0;
  font-variant-numeric:tabular-nums;
}
.msk-topic-count {
  font-size:11px; color:var(--muted); padding:8px 14px; border-bottom:1px solid var(--border);
  font-weight:500;
}
.msk-refresh-btn {
  background:transparent; border:1px solid var(--border-2); color:var(--muted);
  padding:3px 8px; font-size:11px; border-radius:4px; cursor:pointer; font-family:inherit;
}
.msk-refresh-btn:hover { background:var(--surface); color:var(--text); }

/* ── Main pane ── */
.msk-main { display:flex; flex-direction:column; overflow:auto; padding:16px 20px; }
.msk-empty { text-align:center; padding:60px 20px; color:var(--light); font-size:13px; }

/* ── Topic detail ── */
.msk-detail-header { margin-bottom:16px; }
.msk-detail-name { font-size:18px; font-weight:700; color:var(--text); font-family:ui-monospace,'SF Mono',monospace; word-break:break-all; }
.msk-detail-arn { font-size:10px; color:var(--muted); font-family:ui-monospace,'SF Mono',monospace; margin-top:4px; word-break:break-all; }
.msk-detail-cards {
  display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
  gap:8px; margin-bottom:18px;
}
.msk-card {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm);
  padding:10px 12px; position:relative; overflow:hidden;
}
.msk-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:var(--stat-accent,#C7131F); }
.msk-card-value { font-size:20px; font-weight:700; color:var(--stat-accent,#C7131F); line-height:1.1; }
.msk-card-label { font-size:10px; color:var(--muted); margin-top:3px; font-weight:500; text-transform:uppercase; letter-spacing:.04em; }
.msk-section-title {
  font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
  color:var(--muted); margin:18px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--border);
}
/* ── Config JSON tree ── */
.msk-cfg-tree { margin-bottom:16px; }
.msk-cfg-group {
  border:1px solid var(--border); border-radius:var(--radius-sm);
  margin-bottom:4px; overflow:hidden; background:var(--surface);
}
.msk-cfg-group-head {
  display:flex; align-items:center; gap:6px; padding:6px 10px;
  cursor:pointer; font-size:11px; font-weight:600; color:var(--text);
  transition:background .08s; user-select:none;
}
.msk-cfg-group-head:hover { background:var(--surface-2); }
.msk-cfg-chev { font-size:9px; color:var(--muted); width:12px; display:inline-block; transition:transform .15s; }
.msk-cfg-group.collapsed .msk-cfg-chev { transform:rotate(-90deg); }
.msk-cfg-group-count { font-size:9px; color:var(--light); font-weight:500; margin-left:auto; }
.msk-cfg-group-body { border-top:1px solid var(--border); padding:4px 0; }
.msk-cfg-group.collapsed .msk-cfg-group-body { display:none; }
.msk-cfg-row {
  display:flex; gap:8px; padding:3px 10px 3px 28px; font-size:11px;
  font-family:ui-monospace,monospace; align-items:baseline;
}
.msk-cfg-row:hover { background:var(--surface-2); }
.msk-cfg-key { color:var(--text); font-weight:500; white-space:nowrap; min-width:0; }
.msk-cfg-sep { color:var(--light); flex-shrink:0; }
.msk-cfg-val { color:var(--text-2); word-break:break-all; }
.msk-cfg-val-num { color:#1d4ed8; }
.msk-cfg-val-bool { color:#6d28d9; font-weight:600; }

/* ── Partition table ── */
.msk-part-table { width:100%; border-collapse:collapse; font-size:11.5px; }
.msk-part-table thead th {
  background:var(--surface-2); border-bottom:1px solid var(--border);
  padding:6px 10px; text-align:left; font-size:10px; font-weight:600;
  text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
}
.msk-part-table tbody tr { border-bottom:1px solid var(--border); transition:background .08s; }
.msk-part-table tbody tr:hover { background:var(--surface-2); }
.msk-part-table tbody td {
  padding:5px 10px; font-family:ui-monospace,monospace; font-size:11px;
  color:var(--text); font-variant-numeric:tabular-nums;
}
.msk-part-leader {
  display:inline-flex; align-items:center; justify-content:center;
  width:22px; height:22px; border-radius:50%; font-weight:700; font-size:10px;
  background:#dbeafe; color:#1d4ed8; border:1px solid #bfdbfe;
}
.msk-part-replica {
  display:inline-block; padding:1px 5px; border-radius:3px; font-size:10px;
  background:var(--surface-3); color:var(--text-2); margin:1px 2px;
}
.msk-part-isr-ok { color:#15803d; }
.msk-part-isr-warn { color:#b91c1c; font-weight:600; }
.msk-config-note { font-size:10px; color:var(--light); font-style:italic; margin-bottom:8px; }
.msk-loading { color:var(--muted); font-size:12px; padding:20px; text-align:center; }
</style>
</head>
<body>
<div class="cv-header">
  <div class="cv-header-top">
    <div class="cv-service-icon">${icon}</div>
    <div class="cv-title-group">
      <div class="cv-service-title">${cluster}</div>
      <div class="cv-service-subtitle">
        <span>Amazon MSK</span>
        <span class="cv-sep">\u2022</span>
        <span>${accountId}</span>
        <span class="cv-sep">\u2022</span>
        <span>${region}</span>
      </div>
    </div>
    <div class="cv-header-actions">
      <span class="cv-header-meta">${clusterType}</span>
      <span class="cv-header-meta">Kafka ${kafkaVersion}</span>
      <span class="cv-header-meta">${state}</span>
      <span class="cv-header-meta">${brokers} brokers \u00B7 ${instanceType}</span>
    </div>
  </div>
</div>

<div class="msk-body">
  <div class="msk-sidebar">
    <div class="msk-sidebar-head">
      <div class="msk-sidebar-title">
        <span>Kafka Topics</span>
        <button class="msk-refresh-btn" id="msk-refresh">&#8635; Refresh</button>
      </div>
      <input class="msk-search" id="msk-search" type="text" placeholder="Filter topics\u2026" />
    </div>
    <div id="msk-topic-count" class="msk-topic-count" style="display:none"></div>
    <div class="msk-topic-list" id="msk-topic-list">
      <div class="msk-loading">Loading topics\u2026</div>
    </div>
  </div>

  <div class="msk-main" id="msk-main">
    <div class="msk-empty">Select a topic from the list to view its configuration and partitions.</div>
  </div>
</div>

<script nonce="${n}">
var vscode = acquireVsCodeApi();
var topics = [];
var selectedTopic = null;
var searchEl = document.getElementById('msk-search');
var listEl = document.getElementById('msk-topic-list');
var countEl = document.getElementById('msk-topic-count');
var mainEl = document.getElementById('msk-main');

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

document.getElementById('msk-refresh').onclick = function() { vscode.postMessage({ type: 'listTopics' }); };
searchEl.addEventListener('input', function() { renderTopicList(); });

/* ── Topic list ── */
function renderTopicList() {
  var q = (searchEl.value || '').toLowerCase().trim();
  var filtered = q ? topics.filter(function(t) { return t.topicName.toLowerCase().indexOf(q) >= 0; }) : topics;

  countEl.style.display = 'block';
  countEl.textContent = filtered.length + ' of ' + topics.length + ' topics';

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="msk-empty" style="padding:30px 14px">' +
      (topics.length === 0 ? 'No topics found.' : 'No topics match the filter.') + '</div>';
    return;
  }

  listEl.innerHTML = filtered.map(function(t) {
    var cls = selectedTopic === t.topicName ? 'msk-topic-row active' : 'msk-topic-row';
    return '<div class="' + cls + '" data-topic="' + esc(t.topicName) + '">' +
      '<span class="msk-topic-name">' + esc(t.topicName) + '</span></div>';
  }).join('');

  listEl.querySelectorAll('.msk-topic-row').forEach(function(row) {
    row.onclick = function() {
      selectedTopic = row.dataset.topic;
      renderTopicList();
      mainEl.innerHTML = '<div class="msk-loading">Loading topic details\u2026</div>';
      vscode.postMessage({ type: 'describeTopic', topicName: selectedTopic });
    };
  });
}

/* ── Topic detail ── */
function renderTopicDetail(msg) {
  if (msg.error) {
    mainEl.innerHTML = '<div class="msk-empty" style="color:#b91c1c">' + esc(msg.error) + '</div>';
    return;
  }

  var d = msg.detail || {};
  var parts = msg.partitions || [];
  var html = '';

  html += '<div class="msk-detail-header">';
  html += '<div class="msk-detail-name">' + esc(msg.topicName) + '</div>';
  if (d.topicArn) html += '<div class="msk-detail-arn">' + esc(d.topicArn) + '</div>';
  html += '</div>';

  html += '<div class="msk-detail-cards">';
  html += card(d.partitionCount != null ? d.partitionCount : '\u2014', 'Partitions', '#1d4ed8');
  html += card(d.replicationFactor != null ? d.replicationFactor : '\u2014', 'Replication Factor', '#6d28d9');
  html += card(d.status || '\u2014', 'Status', d.status === 'ACTIVE' ? '#15803d' : '#C7131F');
  if (parts.length > 0) {
    var leaders = [];
    parts.forEach(function(p) { if (p.leader != null && leaders.indexOf(p.leader) < 0) leaders.push(p.leader); });
    html += card(leaders.length, 'Unique Leaders', '#0369a1');
    var underReplicated = parts.filter(function(p) { return p.isr && p.replicas && p.isr.length < p.replicas.length; });
    html += card(underReplicated.length, 'Under-Replicated', underReplicated.length > 0 ? '#b91c1c' : '#15803d');
  }
  html += '</div>';

  /* Configuration */
  html += '<div class="msk-section-title">Configuration</div>';
  if (d.configsNote) html += '<div class="msk-config-note">' + esc(d.configsNote) + '</div>';
  html += renderConfigs(d.configs);

  /* Partitions */
  if (parts.length > 0) {
    html += '<div class="msk-section-title">Partitions (' + parts.length + ')</div>';
    html += renderPartitions(parts);
  }

  mainEl.innerHTML = html;

  mainEl.querySelectorAll('.msk-cfg-group-head').forEach(function(head) {
    head.onclick = function() { head.parentElement.classList.toggle('collapsed'); };
  });
}

function card(value, label, color) {
  return '<div class="msk-card" style="--stat-accent:' + color + '">' +
    '<div class="msk-card-value">' + esc(String(value)) + '</div>' +
    '<div class="msk-card-label">' + esc(label) + '</div></div>';
}

function renderConfigs(raw) {
  if (!raw || raw === '(none)') return '<div style="font-size:12px;color:var(--muted);margin-bottom:16px">No configuration data.</div>';

  var pairs = [];
  // MSK DescribeTopic returns the config as a JSON object string
  // (e.g. {"cleanup.policy":"delete","compression.type":"producer",...}).
  // Older/other shapes use newline-separated key=value lines — handle both.
  var parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (var k in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
      var pv = parsed[k];
      pairs.push({ key: k, val: (pv && typeof pv === 'object') ? JSON.stringify(pv) : String(pv) });
    }
  } else {
    var lines = raw.split('\\n').filter(function(l) { return l.trim(); });
    for (var i = 0; i < lines.length; i++) {
      var eq = lines[i].indexOf('=');
      if (eq > 0) {
        pairs.push({ key: lines[i].substring(0, eq).trim(), val: lines[i].substring(eq + 1).trim() });
      } else {
        pairs.push({ key: lines[i].trim(), val: '' });
      }
    }
  }

  if (pairs.length === 0) return '<div class="sfn-json" style="font-size:11px">' + esc(raw) + '</div>';

  pairs.sort(function(a, b) { return a.key.localeCompare(b.key); });

  var groups = {};
  var ungrouped = [];
  for (var i = 0; i < pairs.length; i++) {
    var dot = pairs[i].key.indexOf('.');
    if (dot > 0) {
      var prefix = pairs[i].key.substring(0, dot);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push({ shortKey: pairs[i].key.substring(dot + 1), val: pairs[i].val });
    } else {
      ungrouped.push(pairs[i]);
    }
  }

  var html = '<div class="msk-cfg-tree">';

  var groupKeys = Object.keys(groups).sort();
  for (var g = 0; g < groupKeys.length; g++) {
    var gk = groupKeys[g];
    var items = groups[gk];
    html += '<div class="msk-cfg-group" data-cfg-group="' + esc(gk) + '">';
    html += '<div class="msk-cfg-group-head"><span class="msk-cfg-chev">\u25BE</span>' +
      esc(gk) + '<span class="msk-cfg-group-count">' + items.length + '</span></div>';
    html += '<div class="msk-cfg-group-body">';
    for (var j = 0; j < items.length; j++) {
      html += cfgRow(items[j].shortKey, items[j].val);
    }
    html += '</div></div>';
  }

  if (ungrouped.length > 0) {
    html += '<div class="msk-cfg-group">';
    html += '<div class="msk-cfg-group-head"><span class="msk-cfg-chev">\u25BE</span>other' +
      '<span class="msk-cfg-group-count">' + ungrouped.length + '</span></div>';
    html += '<div class="msk-cfg-group-body">';
    for (var u = 0; u < ungrouped.length; u++) {
      html += cfgRow(ungrouped[u].key, ungrouped[u].val);
    }
    html += '</div></div>';
  }

  html += '</div>';
  return html;
}

function cfgRow(key, val) {
  var cls = 'msk-cfg-val';
  if (/^-?\\d+$/.test(val)) cls = 'msk-cfg-val msk-cfg-val-num';
  else if (val === 'true' || val === 'false') cls = 'msk-cfg-val msk-cfg-val-bool';
  return '<div class="msk-cfg-row"><span class="msk-cfg-key">' + esc(key) + '</span>' +
    '<span class="msk-cfg-sep">=</span><span class="' + cls + '">' + esc(val) + '</span></div>';
}

function renderPartitions(parts) {
  var html = '<table class="msk-part-table"><thead><tr>';
  html += '<th>#</th><th>Leader</th><th>Replicas</th><th>ISR</th><th>Status</th>';
  html += '</tr></thead><tbody>';

  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var replicas = (p.replicas || []).map(function(r) {
      return '<span class="msk-part-replica">' + r + '</span>';
    }).join('');
    var isr = (p.isr || []).join(', ');
    var inSync = p.isr && p.replicas && p.isr.length === p.replicas.length;
    var isrCls = inSync ? 'msk-part-isr-ok' : 'msk-part-isr-warn';
    var statusLabel = inSync ? 'In-sync' : 'Under-replicated';

    html += '<tr>';
    html += '<td>' + (p.partition != null ? p.partition : '\u2014') + '</td>';
    html += '<td>' + (p.leader != null ? '<span class="msk-part-leader">' + p.leader + '</span>' : '\u2014') + '</td>';
    html += '<td>' + (replicas || '\u2014') + '</td>';
    html += '<td>' + (isr || '\u2014') + '</td>';
    html += '<td><span class="' + isrCls + '">' + statusLabel + '</span></td>';
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/* ── Messages ── */
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'topicsList') {
    topics = msg.topics || [];
    if (msg.error) {
      listEl.innerHTML = '<div class="msk-empty" style="color:#b91c1c;padding:20px 14px">' + esc(msg.error) + '</div>';
      countEl.style.display = 'none';
    } else {
      renderTopicList();
    }
    return;
  }
  if (msg.type === 'topicDetail') {
    renderTopicDetail(msg);
    return;
  }
  if (msg.type === 'error') {
    mainEl.innerHTML = '<div class="msk-empty" style="color:#b91c1c">' + esc(msg.error) + '</div>';
  }
});
</script>
</body>
</html>`;
  }
}
