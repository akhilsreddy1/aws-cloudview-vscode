import * as vscode from "vscode";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * ECS drilldown: Cluster → Services → Tasks → Containers.
 *
 * Built from the already-discovered ECS resources (clusters, services, tasks —
 * tasks carry a container summary), so it reflects the last refresh without
 * extra API calls. Tasks are linked to their service via the task `group`
 * (`service:<name>`); tasks with no owning service are grouped under
 * "Standalone tasks". Opening on a service roots the tree at that service.
 *
 * Read-only. Renders an expandable tree with status-coloured leaves.
 */
export class EcsHierarchyPanel {
  private static panels = new Map<string, EcsHierarchyPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly rootName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.rootName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewEcsHierarchy",
      `ECS: ${this.rootName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => EcsHierarchyPanel.panels.delete(resource.arn));

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
    if (resource.type !== ResourceTypes.ecsCluster && resource.type !== ResourceTypes.ecsService) {
      void vscode.window.showWarningMessage("Hierarchy view is only available for ECS clusters and services.");
      return;
    }
    const existing = EcsHierarchyPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new EcsHierarchyPanel(platform, resource);
    EcsHierarchyPanel.panels.set(resource.arn, instance);
  }

  private async loadHierarchy(): Promise<void> {
    void this.panel.webview.postMessage({ type: "loading" });

    // Use the already-discovered ECS resources for this account/region.
    const all = await this.platform.resourceRepo.listByAccounts([this.resource.accountId], ["ecs"]);
    const inRegion = all.filter((r) => r.region === this.resource.region);
    const clusters = inRegion.filter((r) => r.type === ResourceTypes.ecsCluster);
    const services = inRegion.filter((r) => r.type === ResourceTypes.ecsService);
    const tasks = inRegion.filter((r) => r.type === ResourceTypes.ecsTask);

    let tree: TreeNode[] = [];
    if (this.resource.type === ResourceTypes.ecsCluster) {
      const cluster = clusters.find((c) => c.arn === this.resource.arn)
        ?? clusters.find((c) => c.id === this.resource.id);
      tree = cluster ? [buildClusterNode(cluster, services, tasks)] : [];
    } else {
      const service = services.find((s) => s.arn === this.resource.arn)
        ?? services.find((s) => s.id === this.resource.id);
      tree = service ? [buildServiceNode(service, tasks)] : [];
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
    const kind = this.resource.type === ResourceTypes.ecsCluster ? "cluster" : "service";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>ECS: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #ec7211; font-size: 20px; }
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

    /* Level cards — same scheme as LB + RDS so the hierarchy view feels
       consistent across services: top entry → bordered card with accent
       stripe; mid-level → sub-card with lighter accent; group → left rail. */
    .lvl-cluster-card {
      border: 1px solid var(--border); border-radius: var(--radius);
      margin: 14px 0; overflow: hidden; background: var(--surface);
      border-left: 4px solid #ec7211; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .lvl-cluster-card > .node-row {
      background: linear-gradient(to right, #ffedd566, transparent);
      border-bottom: 1px solid var(--border);
      padding: 9px 14px;
    }
    .lvl-cluster-card > .children { margin-left: 0; border-left: none; padding: 8px 14px 12px 14px; }

    .lvl-service-card {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      margin: 8px 0; overflow: hidden; background: var(--surface);
      border-left: 3px solid #1e40af;
    }
    .lvl-service-card > .node-row {
      background: #dbeafe33; padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lvl-service-card > .children { margin-left: 0; border-left: none; padding: 4px 10px 8px 10px; }

    .lvl-task-card {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      margin: 6px 0; overflow: hidden; background: #fafafa;
      border-left: 3px solid #7c3aed;
    }
    .lvl-task-card > .node-row {
      background: #ede9fe33; padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lvl-task-card > .children { margin-left: 0; border-left: none; padding: 4px 10px 8px 10px; }

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
    .pill.cluster { background: #ffedd5; color: #9a3412; }
    .pill.svc { background: #dbeafe; color: #1e40af; }
    .pill.task { background: #e0e7ff; color: #3730a3; }
    .pill.container { background: #f3f4f6; color: #374151; }
    .pill.conn { background: #ecfeff; color: #155e75; }
    .pill.count { background: #dcfce7; color: #166534; }
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
      <span class="icon">\u{1F9F1}</span>
      <span>${name}</span>
      <span class="pill cluster">${kind}</span>
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
      <span><span class="dot" style="background:#16a34a"></span>running / healthy</span>
      <span><span class="dot" style="background:#d97706"></span>pending</span>
      <span><span class="dot" style="background:#dc2626"></span>stopped / unhealthy</span>
    </span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F9F1}</div>
      <div>Loading ECS hierarchy…</div>
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
    function statusColor(state){
      switch ((state||'').toLowerCase()) {
        case 'healthy': return '#16a34a';
        case 'unhealthy': return '#dc2626';
        case 'initial': return '#d97706';
        default: return 'var(--muted)';
      }
    }

    function cardClassFor(node) {
      switch (node.kind) {
        case 'cluster': return 'tree-node lvl-cluster-card';
        case 'service': return 'tree-node lvl-service-card';
        case 'task':    return 'tree-node lvl-task-card';
        case 'group':   return 'tree-node lvl-group-card';
        default:        return 'tree-node';
      }
    }
    function levelLabelFor(node) {
      switch (node.kind) {
        case 'cluster': return 'Cluster';
        case 'service': return 'Service';
        case 'task':    return 'Task';
        case 'group':   return node.groupLabel || 'Group';
        default:        return '';
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

    function renderTree(tree){
      if (!tree.length) {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Nothing to show. Refresh resources to discover ECS services and tasks, then reopen.';
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
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading ECS hierarchy…';
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
  dotState?: string;
  statusLabel?: string;
  /** Visual level — drives the outer card style + the "LEVEL" pre-label. */
  kind?: "cluster" | "service" | "task" | "group" | "leaf";
  /** For `group` cards: the label shown in the LEVEL pre-tag. */
  groupLabel?: string;
  children: TreeNode[];
}

// ─── Assembly helpers ────────────────────────────────────────────────────────

function raw(node: ResourceNode): Record<string, unknown> {
  return (node.rawJson ?? {}) as Record<string, unknown>;
}

/** ECS task/container lastStatus → health-dot bucket. */
function taskDotState(status: string | undefined): string {
  const s = (status ?? "").toUpperCase();
  if (s === "RUNNING") return "healthy";
  if (s === "STOPPED" || s === "DEPROVISIONING" || s === "STOPPING") return "unhealthy";
  if (s === "PENDING" || s === "PROVISIONING" || s === "ACTIVATING") return "initial";
  return "unavailable";
}

/** Container health/last-status → dot bucket. */
function containerDotState(lastStatus: string | undefined, health: string | undefined): string {
  const h = (health ?? "").toUpperCase();
  if (h === "HEALTHY") return "healthy";
  if (h === "UNHEALTHY") return "unhealthy";
  return taskDotState(lastStatus);
}

/** Service running/desired → dot bucket. */
function serviceDotState(running: number, desired: number): string {
  if (desired === 0) return "unavailable";
  if (running >= desired) return "healthy";
  if (running === 0) return "unhealthy";
  return "initial";
}

/** Short image (drop registry + digest noise) for display. */
function shortImage(image: string | undefined): string {
  if (!image) return "";
  const noDigest = image.split("@")[0];
  return noDigest.split("/").pop() ?? noDigest;
}

interface ContainerSummary {
  name?: string;
  image?: string;
  lastStatus?: string;
  healthStatus?: string;
}

function buildTaskNode(task: ResourceNode): TreeNode {
  const r = raw(task);
  const id = (r.taskArn as string | undefined)?.split("/").pop() ?? task.id;
  const lastStatus = (r.lastStatus as string | undefined) ?? "";
  const launchType = r.launchType as string | undefined;
  const az = r.availabilityZone as string | undefined;
  const taskDef = r.TaskDefinitionShort as string | undefined;

  const pills: NodePill[] = [{ text: "task", cls: "task", graphArn: task.arn }];
  if (launchType) pills.push({ text: String(launchType), cls: "container" });

  const subBits: string[] = [];
  if (taskDef) subBits.push(taskDef);
  if (az) subBits.push(az);

  const containers = (r.ContainersSummary as ContainerSummary[] | undefined) ?? [];
  const containerNodes: TreeNode[] = containers.map((c) => {
    const cbits: string[] = [];
    const img = shortImage(c.image);
    if (img) cbits.push(img);
    const pillsC: NodePill[] = [{ text: "container", cls: "container" }];
    if (c.healthStatus && c.healthStatus.toUpperCase() !== "UNKNOWN") {
      pillsC.push({ text: String(c.healthStatus).toLowerCase(), cls: c.healthStatus.toUpperCase() === "HEALTHY" ? "count" : "warn" });
    }
    return {
      title: c.name ?? "(container)",
      sub: cbits.join(" · "),
      pills: pillsC,
      dotState: containerDotState(c.lastStatus, c.healthStatus),
      statusLabel: c.lastStatus ?? "",
      children: [],
    };
  });

  return {
    title: id,
    sub: subBits.join(" · "),
    pills,
    dotState: taskDotState(lastStatus),
    statusLabel: lastStatus,
    kind: "task",
    children: containerNodes,
  };
}

/** Resolve the owning service name from a task's `group` (`service:<name>`). */
function serviceNameFromTask(task: ResourceNode): string | undefined {
  const group = raw(task).group as string | undefined;
  if (group && group.startsWith("service:")) return group.slice("service:".length);
  return undefined;
}

function buildServiceNode(service: ResourceNode, allTasks: ResourceNode[]): TreeNode {
  const r = raw(service);
  const name = (r.serviceName as string | undefined) ?? service.id;
  const status = (r.status as string | undefined) ?? "";
  const desired = Number(r.desiredCount ?? 0);
  const running = Number(r.runningCount ?? 0);
  const pending = Number(r.pendingCount ?? 0);
  const launchType = r.launchType as string | undefined;
  const taskDef = (r.taskDefinition as string | undefined)?.split("/").pop();
  const clusterArn = r.clusterArn as string | undefined;

  const myTasks = allTasks.filter((t) =>
    serviceNameFromTask(t) === name && (raw(t).clusterArn as string | undefined) === clusterArn);

  const pills: NodePill[] = [{ text: "service", cls: "svc", graphArn: service.arn }];
  if (launchType) pills.push({ text: String(launchType), cls: "container" });
  pills.push({ text: `${running}/${desired} running` + (pending ? ` · ${pending} pending` : ""), cls: "count" });

  return {
    title: name,
    sub: taskDef ?? "",
    pills,
    dotState: serviceDotState(running, desired),
    statusLabel: status,
    kind: "service",
    children: myTasks.map(buildTaskNode),
  };
}

function buildClusterNode(cluster: ResourceNode, allServices: ResourceNode[], allTasks: ResourceNode[]): TreeNode {
  const r = raw(cluster);
  const name = (r.clusterName as string | undefined) ?? cluster.id;
  const status = (r.status as string | undefined) ?? "";
  const runningTasks = Number(r.runningTasksCount ?? 0);
  const pendingTasks = Number(r.pendingTasksCount ?? 0);
  const activeServices = Number(r.activeServicesCount ?? 0);

  const clusterServices = allServices.filter((s) => (raw(s).clusterArn as string | undefined) === cluster.arn);
  const clusterTasks = allTasks.filter((t) => (raw(t).clusterArn as string | undefined) === cluster.arn);

  const serviceNames = new Set(clusterServices.map((s) => (raw(s).serviceName as string | undefined) ?? s.id));
  const standaloneTasks = clusterTasks.filter((t) => {
    const sn = serviceNameFromTask(t);
    return !sn || !serviceNames.has(sn);
  });

  const children: TreeNode[] = clusterServices
    .slice()
    .sort((a, b) => String((raw(a).serviceName as string) ?? a.id).localeCompare(String((raw(b).serviceName as string) ?? b.id)))
    .map((s) => buildServiceNode(s, clusterTasks));

  if (standaloneTasks.length > 0) {
    children.push({
      title: `Standalone tasks (${standaloneTasks.length})`,
      kind: "group",
      groupLabel: "Standalone Tasks",
      pills: [{ text: "tasks", cls: "task" }],
      children: standaloneTasks.map(buildTaskNode),
    });
  }

  const pills: NodePill[] = [{ text: "cluster", cls: "cluster", graphArn: cluster.arn }];
  pills.push({ text: `${activeServices} services`, cls: "count" });

  const subBits = [`${runningTasks} running tasks` + (pendingTasks ? ` · ${pendingTasks} pending` : "")];

  return {
    title: name,
    sub: subBits.join(" · "),
    pills,
    dotState: status.toUpperCase() === "ACTIVE" ? "healthy" : "unavailable",
    statusLabel: status,
    kind: "cluster",
    children,
  };
}
