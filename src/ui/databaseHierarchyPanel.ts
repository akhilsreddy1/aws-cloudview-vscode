import * as vscode from "vscode";
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  type DBCluster,
  type DBInstance,
} from "@aws-sdk/client-rds";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Database drilldown: Cluster → member instances → connectivity, plus
 * read-replica chains.
 *
 * Mirrors the load-balancer hierarchy panel. On open it fetches the region's
 * DB clusters + instances live (`DescribeDBClusters`, `DescribeDBInstances`)
 * so instance statuses are current, then assembles an expandable tree:
 *
 *   Cluster (engine, writer/reader endpoints)
 *     └─ Member instance (WRITER / READER, live status, class, AZ, endpoint)
 *          ├─ Connectivity (DB subnet group → subnets/AZs, security groups)
 *          └─ Read replicas (replica instances, recursively)
 *
 * Opening on a standalone instance roots the tree at that instance; opening on
 * a cluster member roots at the parent cluster so siblings are visible.
 * Read-only.
 */
export class DatabaseHierarchyPanel {
  private static panels = new Map<string, DatabaseHierarchyPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly rootName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.rootName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewDbHierarchy",
      `DB: ${this.rootName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => DatabaseHierarchyPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "refresh") {
          await this.loadHierarchy();
        } else if (msg.type === "openNodeGraph" && typeof msg.arn === "string") {
          await vscode.commands.executeCommand("cloudView.openGraphView.fromArn", msg.arn);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    if (resource.type !== ResourceTypes.rdsCluster && resource.type !== ResourceTypes.rdsInstance) {
      void vscode.window.showWarningMessage("Hierarchy view is only available for RDS clusters and instances.");
      return;
    }
    const existing = DatabaseHierarchyPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new DatabaseHierarchyPanel(platform, resource);
    DatabaseHierarchyPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadHierarchy(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    void this.panel.webview.postMessage({ type: "loading" });
    const client = await this.platform.awsClientFactory.rds(scope);

    // Fetch all clusters + instances in the region (live status). Region-wide
    // is required so cross-cluster read-replica chains resolve.
    const clusters: DBCluster[] = [];
    const instances: DBInstance[] = [];
    try {
      let marker: string | undefined;
      do {
        const resp = await this.platform.scheduler.run("rds", "DescribeDBClusters", () =>
          client.send(new DescribeDBClustersCommand({ Marker: marker }))
        );
        for (const c of resp.DBClusters ?? []) clusters.push(c);
        marker = resp.Marker;
      } while (marker);
    } catch (err) {
      this.platform.logger.warn(`DescribeDBClusters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      let marker: string | undefined;
      do {
        const resp = await this.platform.scheduler.run("rds", "DescribeDBInstances", () =>
          client.send(new DescribeDBInstancesCommand({ Marker: marker }))
        );
        for (const i of resp.DBInstances ?? []) instances.push(i);
        marker = resp.Marker;
      } while (marker);
    } catch (err: unknown) {
      this.postError(`DescribeDBInstances failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const instById = new Map<string, DBInstance>();
    for (const i of instances) if (i.DBInstanceIdentifier) instById.set(i.DBInstanceIdentifier, i);
    const clusterById = new Map<string, DBCluster>();
    for (const c of clusters) if (c.DBClusterIdentifier) clusterById.set(c.DBClusterIdentifier, c);

    // Decide the root.
    let tree: TreeNode[] = [];
    if (this.resource.type === ResourceTypes.rdsCluster) {
      const cluster = clusterById.get(this.resource.id);
      tree = cluster ? [buildClusterNode(cluster, instById)] : [];
    } else {
      const inst = instById.get(this.resource.id);
      if (inst?.DBClusterIdentifier && clusterById.has(inst.DBClusterIdentifier)) {
        // Cluster member — root at the parent cluster so siblings are visible.
        tree = [buildClusterNode(clusterById.get(inst.DBClusterIdentifier) as DBCluster, instById)];
      } else if (inst) {
        tree = [buildInstanceNode(inst, undefined, instById, 0, new Set<string>())];
      }
    }

    void this.panel.webview.postMessage({ type: "hierarchy", tree });
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.rootName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const engine = escapeHtml((this.resource.rawJson.Engine as string) ?? "");
    const kind = this.resource.type === ResourceTypes.rdsCluster ? "cluster" : "instance";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>DB: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #527FFF; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }
    .legend { margin-left: auto; display: flex; gap: 12px; font-size: 11px; color: var(--muted); align-items: center; }
    .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }

    .content { flex: 1; overflow: auto; padding: 12px 20px; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    .tree-node { margin: 2px 0; }
    .node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius-sm); flex-wrap: wrap; }
    .node-row:hover { background: var(--surface-2); }
    .twisty { width: 14px; text-align: center; cursor: pointer; color: var(--muted); user-select: none; flex-shrink: 0; }
    .twisty.leaf { visibility: hidden; }
    .children { margin-left: 22px; border-left: 1px dashed var(--border-2); padding-left: 12px; }
    .children.collapsed { display: none; }

    /* Level cards — same visual scheme as the LB hierarchy panel so the
       overall product has consistent "this is a top-level entry, this is a
       container, this is a group" cues across services. */
    .lvl-cluster-card {
      border: 1px solid var(--border); border-radius: var(--radius);
      margin: 14px 0; overflow: hidden; background: var(--surface);
      border-left: 4px solid #1e40af; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .lvl-cluster-card > .node-row {
      background: linear-gradient(to right, #dbeafe66, transparent);
      border-bottom: 1px solid var(--border);
      padding: 9px 14px;
    }
    .lvl-cluster-card > .children { margin-left: 0; border-left: none; padding: 8px 14px 12px 14px; }

    .lvl-instance-card {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      margin: 6px 0; overflow: hidden; background: var(--surface);
      border-left: 3px solid #7c3aed;
    }
    .lvl-instance-card > .node-row {
      background: #ede9fe33; padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lvl-instance-card > .children { margin-left: 0; border-left: none; padding: 4px 10px 8px 10px; }
    /* Writer instances get a green accent to make them obvious. */
    .lvl-instance-card.writer { border-left-color: #166534; }
    .lvl-instance-card.writer > .node-row { background: #dcfce733; }

    .lvl-group-card {
      margin: 6px 0; border-left: 3px solid #9ca3af;
      padding-left: 10px; background: var(--surface);
    }
    .lvl-group-card > .node-row { padding: 4px 6px; }
    .lvl-group-card > .children { margin-left: 14px; border-left: 1px dashed var(--border-2); padding-left: 10px; }

    .lvl-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--muted); font-weight: 700; margin-right: 2px;
    }

    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.healthy { background: #16a34a; }
    .dot.unhealthy { background: #dc2626; }
    .dot.initial { background: #d97706; }
    .dot.draining { background: #6b7280; }
    .dot.unavailable { background: #9ca3af; }

    .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; font-family: 'SF Mono','Fira Code',monospace; }
    .pill.db { background: #dbeafe; color: #1e40af; }
    .pill.role-writer { background: #dcfce7; color: #166534; }
    .pill.role-reader { background: #e0e7ff; color: #3730a3; }
    .pill.role-replica { background: #ede9fe; color: #5b21b6; }
    .pill.conn { background: #f3f4f6; color: #374151; }
    .pill.sg { background: #fef3c7; color: #92400e; }
    .pill.subnet { background: #ecfeff; color: #155e75; }
    .pill.warn { background: #fee2e2; color: #991b1b; }
    .pill.graph { background: #ede9fe; color: #5b21b6; cursor: pointer; }
    .pill.graph:hover { background: #ddd6fe; }

    .node-label { font-size: 13px; color: var(--text); }
    .node-sub { font-size: 11px; color: var(--muted); }
    .node-status { font-size: 11px; margin-left: 2px; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F5C4}\u{FE0F}</span>
      <span>${name}</span>
      <span class="pill db">${kind}</span>
      ${engine ? `<span class="pill role-reader">${engine}</span>` : ""}
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <button class="btn" id="refresh-btn">↻ Refresh</button>
    <button class="btn" id="expand-btn">Expand all</button>
    <button class="btn" id="collapse-btn">Collapse all</button>
    <span class="legend">
      <span><span class="dot" style="background:#16a34a"></span>available</span>
      <span><span class="dot" style="background:#d97706"></span>transitioning</span>
      <span><span class="dot" style="background:#dc2626"></span>failed / stopped</span>
    </span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F5C4}\u{FE0F}</div>
      <div>Loading database hierarchy…</div>
    </div>
    <div id="tree" style="display:none;"></div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var emptyEl = document.getElementById('empty');
    var treeEl = document.getElementById('tree');
    var errorBanner = document.getElementById('error-banner');
    var refreshBtn = document.getElementById('refresh-btn');

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg){ errorBanner.textContent = msg; errorBanner.style.display='block'; setTimeout(function(){errorBanner.style.display='none';},8000); }

    function dotClass(state){
      switch ((state||'').toLowerCase()) {
        case 'healthy': return 'healthy';
        case 'unhealthy': return 'unhealthy';
        case 'initial': return 'initial';
        case 'draining': return 'draining';
        default: return 'unavailable';
      }
    }

    /* Map TreeNode.kind → outer card class + level label text. */
    function cardClassFor(node) {
      switch (node.kind) {
        case 'cluster':  return 'tree-node lvl-cluster-card';
        case 'instance': return 'tree-node lvl-instance-card' + (node.role === 'WRITER' ? ' writer' : '');
        case 'group':    return 'tree-node lvl-group-card';
        default:         return 'tree-node';
      }
    }
    function levelLabelFor(node) {
      switch (node.kind) {
        case 'cluster':  return 'Cluster';
        case 'instance': return 'Instance';
        case 'group':    return node.groupLabel || 'Group';
        default:         return '';
      }
    }

    function renderNode(node){
      var hasChildren = node.children && node.children.length;
      var twisty = hasChildren ? '<span class="twisty" data-toggle>▼</span>' : '<span class="twisty leaf">▼</span>';
      var dot = node.dotState ? '<span class="dot ' + dotClass(node.dotState) + '"></span>' : '';
      var pills = (node.pills || []).map(function(p){
        var attr = p.graphArn ? ' data-graph-arn="' + esc(p.graphArn) + '" title="Open in graph view"' : '';
        return '<span class="pill ' + esc(p.cls) + '"' + attr + '>' + esc(p.text) + '</span>';
      }).join(' ');
      var lvl = levelLabelFor(node);
      var lvlHtml = lvl ? '<span class="lvl-label">' + esc(lvl) + '</span>' : '';
      var title = node.title ? '<span class="node-label">' + esc(node.title) + '</span>' : '';
      var sub = node.sub ? '<span class="node-sub">' + esc(node.sub) + '</span>' : '';
      var status = node.statusLabel ? '<span class="node-status" style="color:' + statusColor(node.dotState) + '">' + esc(node.statusLabel) + '</span>' : '';
      var inner = hasChildren ? '<div class="children">' + node.children.map(renderNode).join('') + '</div>' : '';
      return '<div class="' + cardClassFor(node) + '"><div class="node-row">' + twisty + dot + lvlHtml + pills + ' ' + title + ' ' + sub + status + '</div>' + inner + '</div>';
    }
    function statusColor(state){
      switch ((state||'').toLowerCase()) {
        case 'healthy': return '#16a34a';
        case 'unhealthy': return '#dc2626';
        case 'initial': return '#d97706';
        default: return 'var(--muted)';
      }
    }

    function renderTree(tree){
      if (!tree.length) {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'No matching cluster or instance found (try Refresh).';
        treeEl.style.display = 'none';
        return;
      }
      emptyEl.style.display = 'none';
      treeEl.style.display = 'block';
      treeEl.innerHTML = tree.map(renderNode).join('');
      wireTwisties();
      wireGraphLinks();
    }
    function wireTwisties(){
      treeEl.querySelectorAll('[data-toggle]').forEach(function(tw){
        tw.onclick = function(){
          var children = tw.closest('.tree-node').querySelector(':scope > .children');
          if (!children) return;
          var collapsed = children.classList.toggle('collapsed');
          tw.textContent = collapsed ? '▶' : '▼';
        };
      });
    }
    function wireGraphLinks(){
      treeEl.querySelectorAll('[data-graph-arn]').forEach(function(el){
        el.onclick = function(){ vscode.postMessage({ type:'openNodeGraph', arn: el.getAttribute('data-graph-arn') }); };
      });
    }

    document.getElementById('refresh-btn').onclick = function(){ refreshBtn.disabled = true; refreshBtn.textContent = '…'; vscode.postMessage({ type:'refresh' }); };
    document.getElementById('expand-btn').onclick = function(){
      treeEl.querySelectorAll('.children').forEach(function(c){ c.classList.remove('collapsed'); });
      treeEl.querySelectorAll('[data-toggle]').forEach(function(t){ t.textContent = '▼'; });
    };
    document.getElementById('collapse-btn').onclick = function(){
      treeEl.querySelectorAll('.tree-node .children .children').forEach(function(c){ c.classList.add('collapsed'); });
      treeEl.querySelectorAll('.tree-node .children [data-toggle]').forEach(function(t){ t.textContent = '▶'; });
    };

    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (m.type === 'loading') {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading database hierarchy…';
        treeEl.style.display = 'none';
      } else if (m.type === 'hierarchy') {
        refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh';
        renderTree(m.tree || []);
      } else if (m.type === 'error') {
        refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh';
        showError(m.message || 'Unknown error');
      }
    });

    vscode.postMessage({ type:'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Tree node model (serialized to the webview) ─────────────────────────────

interface NodePill { text: string; cls: string; graphArn?: string }
interface TreeNode {
  title: string;
  sub?: string;
  pills: NodePill[];
  /** Health dot state: healthy | unhealthy | initial | draining | unavailable. */
  dotState?: string;
  /** Status text shown after the dot (e.g. "available", "backing-up"). */
  statusLabel?: string;
  /** Visual level — drives the outer card style + the "LEVEL" pre-label. */
  kind?: "cluster" | "instance" | "group" | "leaf";
  /** For `instance` cards: "WRITER" or "READER" — writers get a green accent. */
  role?: "WRITER" | "READER";
  /** For `group` cards: the label shown in the LEVEL pre-tag. */
  groupLabel?: string;
  children: TreeNode[];
}

// ─── Assembly helpers ────────────────────────────────────────────────────────

/** Map an RDS status string to a health-dot bucket. */
function rdsDotState(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "available") return "healthy";
  if (/(fail|incompatible|stopped|deleting|error|inaccessible|terminated)/.test(s)) return "unhealthy";
  if (/(creating|modifying|starting|stopping|backing|rebooting|maintenance|upgrading|configuring|renaming|resetting|moving|migrating|converting)/.test(s)) return "initial";
  return "unavailable";
}

function buildInstanceNode(
  inst: DBInstance,
  role: "WRITER" | "READER" | undefined,
  instById: Map<string, DBInstance>,
  depth: number,
  seen: Set<string>,
): TreeNode {
  const id = inst.DBInstanceIdentifier ?? "(unknown)";
  if (id !== "(unknown)") seen.add(id);
  const status = inst.DBInstanceStatus ?? "unknown";

  const pills: NodePill[] = [];
  if (role) pills.push({ text: role, cls: role === "WRITER" ? "role-writer" : "role-reader" });
  if (inst.DBInstanceClass) pills.push({ text: inst.DBInstanceClass, cls: "db" });
  if (inst.MultiAZ) pills.push({ text: "multi-az", cls: "conn" });

  const subBits: string[] = [];
  const endpoint = inst.Endpoint?.Address;
  if (endpoint) subBits.push(endpoint + (inst.Endpoint?.Port ? `:${inst.Endpoint.Port}` : ""));
  if (inst.AvailabilityZone) subBits.push(inst.AvailabilityZone);
  const engine = `${inst.Engine ?? ""} ${inst.EngineVersion ?? ""}`.trim();
  if (engine) subBits.push(engine);

  const children: TreeNode[] = [];

  // Connectivity branch.
  const connChildren: TreeNode[] = [];
  const sng = inst.DBSubnetGroup;
  if (sng?.DBSubnetGroupName) {
    connChildren.push({
      title: sng.DBSubnetGroupName,
      sub: sng.VpcId ?? "",
      pills: [{ text: "subnet group", cls: "conn" }],
      children: (sng.Subnets ?? []).map((s) => ({
        title: s.SubnetIdentifier ?? "(subnet)",
        sub: s.SubnetAvailabilityZone?.Name ?? "",
        pills: [{ text: "subnet", cls: "subnet" }],
        children: [],
      })),
    });
  }
  for (const g of inst.VpcSecurityGroups ?? []) {
    if (!g.VpcSecurityGroupId) continue;
    connChildren.push({
      title: g.VpcSecurityGroupId,
      sub: g.Status ?? "",
      pills: [{ text: "sg", cls: "sg" }],
      children: [],
    });
  }
  if (inst.PubliclyAccessible) {
    connChildren.push({ title: "Publicly accessible", pills: [{ text: "public", cls: "warn" }], children: [] });
  }
  if (connChildren.length) {
    children.push({ title: "Connectivity", kind: "group", groupLabel: "Connectivity", pills: [{ text: "connectivity", cls: "conn" }], children: connChildren });
  }

  // Read-replica chain.
  const replicaIds = inst.ReadReplicaDBInstanceIdentifiers ?? [];
  if (replicaIds.length && depth < 5) {
    const replicaNodes: TreeNode[] = replicaIds.map((rid) => {
      const r = instById.get(rid);
      if (r && !seen.has(rid)) {
        const node = buildInstanceNode(r, "READER", instById, depth + 1, seen);
        node.pills = [{ text: "replica", cls: "role-replica" }, ...node.pills.filter((p) => p.cls !== "role-reader")];
        return node;
      }
      // Replica not in this region's listing (e.g. cross-region) or already shown.
      return {
        title: rid,
        sub: r ? "" : "(other region / not listed)",
        pills: [{ text: "replica", cls: "role-replica" }],
        dotState: r ? rdsDotState(r.DBInstanceStatus) : undefined,
        children: [],
      };
    });
    children.push({ title: `Read replicas (${replicaIds.length})`, kind: "group", groupLabel: "Read Replicas", pills: [{ text: "replicas", cls: "role-replica" }], children: replicaNodes });
  }

  return {
    title: id,
    sub: subBits.join(" · "),
    pills,
    dotState: rdsDotState(status),
    statusLabel: status,
    kind: "instance",
    role,
    children,
  };
}

function buildClusterNode(cluster: DBCluster, instById: Map<string, DBInstance>): TreeNode {
  const id = cluster.DBClusterIdentifier ?? "(cluster)";
  const status = cluster.Status ?? "unknown";
  const seen = new Set<string>();

  const pills: NodePill[] = [];
  const engine = `${cluster.Engine ?? ""} ${cluster.EngineVersion ?? ""}`.trim();
  if (engine) pills.push({ text: engine, cls: "db" });
  if (cluster.MultiAZ) pills.push({ text: "multi-az", cls: "conn" });

  const subBits: string[] = [];
  if (cluster.Endpoint) subBits.push(`writer ${cluster.Endpoint}${cluster.Port ? `:${cluster.Port}` : ""}`);
  if (cluster.ReaderEndpoint) subBits.push(`reader ${cluster.ReaderEndpoint}`);

  // Members: writer first, then readers ordered by promotion tier.
  const members = (cluster.DBClusterMembers ?? []).slice().sort((a, b) => {
    if (a.IsClusterWriter !== b.IsClusterWriter) return a.IsClusterWriter ? -1 : 1;
    return (a.PromotionTier ?? 99) - (b.PromotionTier ?? 99);
  });

  const memberNodes: TreeNode[] = members.map((m) => {
    const inst = m.DBInstanceIdentifier ? instById.get(m.DBInstanceIdentifier) : undefined;
    const role: "WRITER" | "READER" = m.IsClusterWriter ? "WRITER" : "READER";
    if (inst) return buildInstanceNode(inst, role, instById, 1, seen);
    return {
      title: m.DBInstanceIdentifier ?? "(member)",
      sub: "(instance not listed)",
      pills: [{ text: role, cls: role === "WRITER" ? "role-writer" : "role-reader" }],
      children: [],
    };
  });

  return {
    title: id,
    sub: subBits.join(" · "),
    pills,
    dotState: rdsDotState(status),
    statusLabel: status,
    kind: "cluster",
    children: memberNodes,
  };
}
