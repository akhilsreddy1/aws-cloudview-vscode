import * as vscode from "vscode";
import {
  DescribeListenersCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  type Listener,
  type Rule,
  type Action,
  type TargetGroup,
  type TargetHealthDescription,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Load balancer drilldown: LB → Listeners → (Rules) → Target Groups → Targets.
 *
 * Lazily fetches the full hierarchy on open:
 *   1. `DescribeListeners` — the protocol:port entry points
 *   2. `DescribeRules` per listener — path/host routing (ALB) or the single
 *      default action (NLB/GLB)
 *   3. `DescribeTargetGroups` — TG metadata for every referenced ARN (batched)
 *   4. `DescribeTargetHealth` per TG — registered targets (instance IDs / IPs)
 *      plus their live health state
 *
 * Read-only. Renders an expandable tree with health-coloured target leaves.
 */
export class LoadBalancerHierarchyPanel {
  private static panels = new Map<string, LoadBalancerHierarchyPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly lbArn: string;
  private readonly lbName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.lbArn = resource.arn;
    this.lbName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLbHierarchy",
      `LB: ${this.lbName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => LoadBalancerHierarchyPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "refresh") {
          await this.loadHierarchy();
        } else if (msg.type === "openTargetGroupGraph" && typeof msg.arn === "string") {
          await vscode.commands.executeCommand("cloudView.openGraphView.fromArn", msg.arn);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    if (resource.type !== "aws.elbv2.load-balancer") {
      void vscode.window.showWarningMessage("Hierarchy view is only available for load balancers.");
      return;
    }
    const existing = LoadBalancerHierarchyPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new LoadBalancerHierarchyPanel(platform, resource);
    LoadBalancerHierarchyPanel.panels.set(resource.arn, instance);
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
    const client = await this.platform.awsClientFactory.elbv2(scope);

    // 1. Listeners
    const listeners: Listener[] = [];
    {
      let marker: string | undefined;
      do {
        const resp = await this.platform.scheduler.run("elbv2", "DescribeListeners", () =>
          client.send(new DescribeListenersCommand({ LoadBalancerArn: this.lbArn, Marker: marker }))
        );
        for (const l of resp.Listeners ?? []) listeners.push(l);
        marker = resp.NextMarker;
      } while (marker);
    }

    // 2. Rules per listener + collect every referenced target-group ARN.
    const tgArns = new Set<string>();
    const listenerNodes: ListenerNode[] = [];
    for (const listener of listeners) {
      if (!listener.ListenerArn) continue;

      let rules: Rule[] = [];
      try {
        // DescribeRules works for ALB (path/host rules) and returns the
        // single default rule for NLB/GLB. Best-effort — some LB types or
        // permissions may reject it; we fall back to DefaultActions.
        const resp = await this.platform.scheduler.run("elbv2", "DescribeRules", () =>
          client.send(new DescribeRulesCommand({ ListenerArn: listener.ListenerArn }))
        );
        rules = resp.Rules ?? [];
      } catch {
        rules = [];
      }

      const ruleNodes: RuleNode[] = [];
      // If DescribeRules returned nothing usable, synthesize a default rule
      // from the listener's DefaultActions so the tree still shows the target.
      const ruleSource: Array<{ rule?: Rule; actions: Action[]; conditionLabel: string }> =
        rules.length > 0
          ? rules.map((r) => ({
              rule: r,
              actions: r.Actions ?? [],
              conditionLabel: ruleConditionLabel(r),
            }))
          : [{ actions: listener.DefaultActions ?? [], conditionLabel: "default" }];

      for (const { actions, conditionLabel } of ruleSource) {
        const targetGroupArns = collectTargetGroupArns(actions);
        const actionType = actions[0]?.Type ?? "unknown";
        for (const arn of targetGroupArns) tgArns.add(arn);
        ruleNodes.push({
          conditionLabel,
          actionType,
          // For redirect/fixed-response actions there are no TGs — show the action instead.
          actionSummary: actionSummary(actions),
          targetGroupArns,
        });
      }

      listenerNodes.push({
        protocol: listener.Protocol ?? "?",
        port: listener.Port ?? 0,
        listenerArn: listener.ListenerArn,
        rules: ruleNodes,
      });
    }

    // 3. Target group metadata (batched) + 4. target health per TG.
    const tgMeta = new Map<string, TargetGroup>();
    if (tgArns.size > 0) {
      // DescribeTargetGroups accepts up to 20 ARNs per call; chunk to be safe.
      const arnList = [...tgArns];
      for (let i = 0; i < arnList.length; i += 20) {
        const chunk = arnList.slice(i, i + 20);
        try {
          const resp = await this.platform.scheduler.run("elbv2", "DescribeTargetGroups", () =>
            client.send(new DescribeTargetGroupsCommand({ TargetGroupArns: chunk }))
          );
          for (const tg of resp.TargetGroups ?? []) {
            if (tg.TargetGroupArn) tgMeta.set(tg.TargetGroupArn, tg);
          }
        } catch (err) {
          this.platform.logger.warn(`DescribeTargetGroups failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const tgHealth = new Map<string, TargetNode[]>();
    for (const arn of tgArns) {
      try {
        const resp = await this.platform.scheduler.run("elbv2", "DescribeTargetHealth", () =>
          client.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }))
        );
        tgHealth.set(arn, (resp.TargetHealthDescriptions ?? []).map(targetNodeFromHealth));
      } catch (err) {
        this.platform.logger.warn(`DescribeTargetHealth failed for ${arn}: ${err instanceof Error ? err.message : String(err)}`);
        tgHealth.set(arn, []);
      }
    }

    // Assemble the serializable tree.
    const tree = listenerNodes.map((ln) => ({
      protocol: ln.protocol,
      port: ln.port,
      rules: ln.rules.map((r) => ({
        conditionLabel: r.conditionLabel,
        actionType: r.actionType,
        actionSummary: r.actionSummary,
        targetGroups: r.targetGroupArns.map((arn) => {
          const meta = tgMeta.get(arn);
          const targets = tgHealth.get(arn) ?? [];
          const healthyCount = targets.filter((t) => t.state === "healthy").length;
          return {
            arn,
            name: meta?.TargetGroupName ?? arn.split("/").slice(-2, -1)[0] ?? arn,
            protocol: meta?.Protocol,
            port: meta?.Port,
            targetType: meta?.TargetType,
            healthCheckPath: meta?.HealthCheckPath,
            targets,
            healthyCount,
            totalCount: targets.length,
          };
        }),
      })),
    }));

    void this.panel.webview.postMessage({ type: "hierarchy", tree });
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.lbName);
    const arn = escapeHtml(this.lbArn);
    const region = escapeHtml(this.resource.region);
    const lbType = escapeHtml((this.resource.rawJson.Type as string) ?? "application");
    const scheme = escapeHtml((this.resource.rawJson.Scheme as string) ?? "");
    const dns = escapeHtml((this.resource.rawJson.DNSName as string) ?? "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>LB: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #ec7211; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono', 'Fira Code', monospace; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }
    .legend { margin-left: auto; display: flex; gap: 12px; font-size: 11px; color: var(--muted); align-items: center; }
    .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }

    .content { flex: 1; overflow: auto; padding: 12px 20px; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    /* Tree */
    .tree-node { margin: 2px 0; }
    .node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius-sm); flex-wrap: wrap; }
    .node-row:hover { background: var(--surface-2); }
    .twisty { width: 14px; text-align: center; cursor: pointer; color: var(--muted); user-select: none; flex-shrink: 0; }
    .twisty.leaf { visibility: hidden; }
    .children { margin-left: 22px; border-left: 1px dashed var(--border-2); padding-left: 12px; }
    .children.collapsed { display: none; }

    /* Level cards — give each hierarchy level a distinct visual container so
       the eye doesn't get lost in the indent. Three levels: Listener,
       (Rule), Target Group; targets are leaves. */
    .lvl-listener-card {
      border: 1px solid var(--border); border-radius: var(--radius);
      margin: 14px 0; overflow: hidden; background: var(--surface);
      border-left: 4px solid #1e40af; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .lvl-listener-card > .node-row {
      background: linear-gradient(to right, #dbeafe66, transparent);
      border-bottom: 1px solid var(--border);
      padding: 9px 14px;
    }
    .lvl-listener-card > .children { margin-left: 0; border-left: none; padding: 8px 14px 12px 14px; }

    .lvl-rule-card {
      margin: 6px 0; border-left: 3px solid #9ca3af;
      padding-left: 10px; background: var(--surface);
    }
    .lvl-rule-card > .node-row { padding: 4px 6px; }
    .lvl-rule-card > .children { margin-left: 14px; border-left: 1px dashed var(--border-2); padding-left: 10px; }

    .lvl-tg-card {
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      margin: 6px 0; overflow: hidden; background: #fffbeb33;
      border-left: 3px solid #d97706;
    }
    .lvl-tg-card > .node-row {
      background: #fef3c744; padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lvl-tg-card > .children { margin-left: 0; border-left: none; padding: 4px 10px 8px 10px; }

    /* Tiny uppercase level label, prepended in each card header so the eye
       can pick the hierarchy out without counting indent levels. */
    .lvl-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--muted); font-weight: 700; margin-right: 2px;
    }

    .pill { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace; }
    .pill.listener { background: #dbeafe; color: #1e40af; }
    .pill.rule { background: #f3f4f6; color: #374151; }
    .pill.tg { background: #fef3c7; color: #92400e; cursor: pointer; border: 1px solid #fde68a; }
    .pill.tg:hover { background: #fde68a; }
    .pill.action { background: #ede9fe; color: #5b21b6; }

    .node-label { font-size: 13px; color: var(--text); }
    .node-sub { font-size: 11px; color: var(--muted); }

    /* Health summary on a target group — text count + a small progress bar. */
    .health-summary { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; }
    .health-count { font-weight: 600; font-variant-numeric: tabular-nums; }
    .health-count.all { color: #16a34a; }
    .health-count.none { color: #dc2626; }
    .health-count.some { color: #d97706; }
    .health-count.empty { color: var(--muted); font-weight: 500; }
    .health-bar { width: 56px; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
    .health-bar-fill { height: 100%; transition: width .15s; }
    .health-bar-fill.all { background: #16a34a; }
    .health-bar-fill.some { background: #d97706; }
    .health-bar-fill.none { background: #dc2626; }

    .target-row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; }
    .target-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .target-dot.healthy { background: #16a34a; }
    .target-dot.unhealthy { background: #dc2626; }
    .target-dot.initial { background: #d97706; }
    .target-dot.draining { background: #6b7280; }
    .target-dot.unused, .target-dot.unavailable { background: #9ca3af; }
    .target-id { color: var(--text); }
    .target-detail { color: var(--muted); }
    .target-reason { color: #b91c1c; font-style: italic; font-family: inherit; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{2696}\u{FE0F}</span>
      <span>${name}</span>
      <span class="pill listener">${lbType}</span>
      ${scheme ? `<span class="pill rule">${scheme}</span>` : ""}
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      ${dns ? `<span><span class="label">DNS:</span> <code>${dns}</code></span>` : ""}
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <button class="btn" id="refresh-btn">↻ Refresh</button>
    <button class="btn" id="expand-btn">Expand all</button>
    <button class="btn" id="collapse-btn">Collapse all</button>
    <span class="legend">
      <span><span class="dot" style="background:#16a34a"></span>healthy</span>
      <span><span class="dot" style="background:#dc2626"></span>unhealthy</span>
      <span><span class="dot" style="background:#d97706"></span>initial</span>
      <span><span class="dot" style="background:#6b7280"></span>draining</span>
    </span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{2696}\u{FE0F}</div>
      <div>Loading load balancer hierarchy…</div>
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

    function targetDotClass(state) {
      switch ((state||'').toLowerCase()) {
        case 'healthy': return 'healthy';
        case 'unhealthy': return 'unhealthy';
        case 'initial': return 'initial';
        case 'draining': return 'draining';
        case 'unused': return 'unused';
        default: return 'unavailable';
      }
    }

    function renderTargets(targets) {
      if (!targets.length) return '<div class="target-row"><span class="target-detail">(no registered targets)</span></div>';
      return targets.map(function(t){
        var reason = t.reason && t.state !== 'healthy' ? ' <span class="target-reason">(' + esc(t.reason) + ')</span>' : '';
        var portPart = t.port ? ':' + esc(t.port) : '';
        var az = t.az ? ' · ' + esc(t.az) : '';
        return '<div class="target-row">' +
          '<span class="target-dot ' + targetDotClass(t.state) + '"></span>' +
          '<span class="target-id">' + esc(t.id) + portPart + '</span>' +
          '<span class="target-detail">' + esc(t.state) + az + '</span>' +
          reason +
        '</div>';
      }).join('');
    }

    function healthBucket(healthy, total) {
      if (total === 0) return 'empty';
      if (healthy === total) return 'all';
      if (healthy === 0) return 'none';
      return 'some';
    }

    function renderTargetGroup(tg) {
      var bucket = healthBucket(tg.healthyCount, tg.totalCount);
      var pct = tg.totalCount > 0 ? Math.round((tg.healthyCount / tg.totalCount) * 100) : 0;
      var healthHtml;
      if (tg.totalCount === 0) {
        healthHtml = '<span class="health-summary"><span class="health-count empty">no targets</span></span>';
      } else {
        healthHtml = '<span class="health-summary">' +
          '<span class="health-count ' + bucket + '">' + tg.healthyCount + '/' + tg.totalCount + ' healthy</span>' +
          '<span class="health-bar"><span class="health-bar-fill ' + bucket + '" style="width:' + pct + '%"></span></span>' +
        '</span>';
      }
      var meta = [tg.protocol, tg.port].filter(Boolean).join(':');
      var typeLabel = tg.targetType ? ' · ' + esc(tg.targetType) : '';
      return '<div class="tree-node lvl-tg-card">' +
        '<div class="node-row">' +
          '<span class="twisty" data-toggle>▼</span>' +
          '<span class="lvl-label">Target Group</span>' +
          '<span class="pill tg" data-tg-arn="' + esc(tg.arn) + '" title="Open in graph view">' + esc(tg.name) + '</span>' +
          '<span class="node-sub">' + esc(meta) + esc(typeLabel) + '</span>' +
          healthHtml +
        '</div>' +
        '<div class="children">' + renderTargets(tg.targets) + '</div>' +
      '</div>';
    }

    function renderRule(rule) {
      var hasTgs = rule.targetGroups && rule.targetGroups.length > 0;
      var inner = hasTgs
        ? rule.targetGroups.map(renderTargetGroup).join('')
        : '<div class="target-row"><span class="pill action">' + esc(rule.actionType) + '</span> <span class="target-detail">' + esc(rule.actionSummary || '') + '</span></div>';
      var twisty = hasTgs ? '<span class="twisty" data-toggle>▼</span>' : '<span class="twisty leaf">▼</span>';
      var countSub = hasTgs ? '<span class="node-sub">' + rule.targetGroups.length + ' target group' + (rule.targetGroups.length === 1 ? '' : 's') + '</span>' : '<span class="node-sub">→ ' + esc(rule.actionType) + '</span>';
      return '<div class="tree-node lvl-rule-card">' +
        '<div class="node-row">' +
          twisty +
          '<span class="lvl-label">Rule</span>' +
          '<span class="pill rule">' + esc(rule.conditionLabel) + '</span>' +
          countSub +
        '</div>' +
        '<div class="children">' + inner + '</div>' +
      '</div>';
    }

    function renderListener(ln) {
      var rulesHtml = ln.rules.length
        ? ln.rules.map(renderRule).join('')
        : '<div class="target-row"><span class="target-detail">(no rules)</span></div>';
      return '<div class="tree-node lvl-listener-card">' +
        '<div class="node-row">' +
          '<span class="twisty" data-toggle>▼</span>' +
          '<span class="lvl-label">Listener</span>' +
          '<span class="pill listener">' + esc(ln.protocol) + ':' + esc(ln.port) + '</span>' +
          '<span class="node-sub">' + ln.rules.length + ' rule' + (ln.rules.length === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="children">' + rulesHtml + '</div>' +
      '</div>';
    }

    function renderTree(tree) {
      if (!tree.length) {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'This load balancer has no listeners.';
        treeEl.style.display = 'none';
        return;
      }
      emptyEl.style.display = 'none';
      treeEl.style.display = 'block';
      treeEl.innerHTML = tree.map(renderListener).join('');
      wireTwisties();
      wireTgLinks();
    }

    function wireTwisties() {
      treeEl.querySelectorAll('[data-toggle]').forEach(function(tw){
        tw.onclick = function(){
          var children = tw.closest('.tree-node').querySelector(':scope > .children');
          if (!children) return;
          var collapsed = children.classList.toggle('collapsed');
          tw.textContent = collapsed ? '▶' : '▼';
        };
      });
    }
    function wireTgLinks() {
      treeEl.querySelectorAll('[data-tg-arn]').forEach(function(el){
        el.onclick = function(){ vscode.postMessage({ type: 'openTargetGroupGraph', arn: el.getAttribute('data-tg-arn') }); };
      });
    }

    document.getElementById('refresh-btn').onclick = function(){
      refreshBtn.disabled = true; refreshBtn.textContent = '…';
      vscode.postMessage({ type: 'refresh' });
    };
    document.getElementById('expand-btn').onclick = function(){
      treeEl.querySelectorAll('.children').forEach(function(c){ c.classList.remove('collapsed'); });
      treeEl.querySelectorAll('[data-toggle]').forEach(function(t){ t.textContent = '▼'; });
    };
    document.getElementById('collapse-btn').onclick = function(){
      // Collapse everything below the top-level listeners.
      treeEl.querySelectorAll('.tree-node .children .children').forEach(function(c){ c.classList.add('collapsed'); });
      treeEl.querySelectorAll('.tree-node .children [data-toggle]').forEach(function(t){ t.textContent = '▶'; });
    };

    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (m.type === 'loading') {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading load balancer hierarchy…';
        treeEl.style.display = 'none';
      } else if (m.type === 'hierarchy') {
        refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh';
        renderTree(m.tree || []);
      } else if (m.type === 'error') {
        refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh';
        showError(m.message || 'Unknown error');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Tree node intermediate types (server-side) ──────────────────────────────

interface ListenerNode {
  protocol: string;
  port: number;
  listenerArn: string;
  rules: RuleNode[];
}
interface RuleNode {
  conditionLabel: string;
  actionType: string;
  actionSummary: string;
  targetGroupArns: string[];
}
interface TargetNode {
  id: string;
  port?: number;
  state: string;
  reason?: string;
  az?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect every target-group ARN referenced by a rule's actions (handles weighted forward configs). */
function collectTargetGroupArns(actions: Action[]): string[] {
  const arns: string[] = [];
  for (const action of actions) {
    if (action.TargetGroupArn) arns.push(action.TargetGroupArn);
    for (const tg of action.ForwardConfig?.TargetGroups ?? []) {
      if (tg.TargetGroupArn) arns.push(tg.TargetGroupArn);
    }
  }
  return [...new Set(arns)];
}

/** Human-readable label for a rule's match conditions (path/host/etc.) or "default". */
function ruleConditionLabel(rule: Rule): string {
  if (rule.IsDefault) return "default";
  const parts: string[] = [];
  for (const cond of rule.Conditions ?? []) {
    if (cond.Field === "path-pattern") {
      parts.push(`path ${(cond.PathPatternConfig?.Values ?? cond.Values ?? []).join(",")}`);
    } else if (cond.Field === "host-header") {
      parts.push(`host ${(cond.HostHeaderConfig?.Values ?? cond.Values ?? []).join(",")}`);
    } else if (cond.Field === "http-request-method") {
      parts.push(`method ${(cond.HttpRequestMethodConfig?.Values ?? []).join(",")}`);
    } else if (cond.Field) {
      parts.push(cond.Field);
    }
  }
  const priority = rule.Priority && rule.Priority !== "default" ? `[${rule.Priority}] ` : "";
  return priority + (parts.join(" · ") || "rule");
}

/** Short description of what a rule's primary action does (for non-forward actions). */
function actionSummary(actions: Action[]): string {
  const a = actions[0];
  if (!a) return "";
  switch (a.Type) {
    case "redirect": {
      const c = a.RedirectConfig;
      return `redirect → ${c?.Protocol ?? ""}://${c?.Host ?? "#{host}"}:${c?.Port ?? "#{port}"}${c?.Path ?? ""} (${c?.StatusCode ?? ""})`;
    }
    case "fixed-response":
      return `fixed ${a.FixedResponseConfig?.StatusCode ?? ""} ${a.FixedResponseConfig?.ContentType ?? ""}`;
    case "authenticate-cognito":
      return "authenticate via Cognito";
    case "authenticate-oidc":
      return "authenticate via OIDC";
    case "forward":
      return "forward to target group(s)";
    default:
      return a.Type ?? "";
  }
}

function targetNodeFromHealth(d: TargetHealthDescription): TargetNode {
  return {
    id: d.Target?.Id ?? "(unknown)",
    port: d.Target?.Port,
    az: d.Target?.AvailabilityZone,
    state: d.TargetHealth?.State ?? "unknown",
    reason: d.TargetHealth?.Description || d.TargetHealth?.Reason,
  };
}
