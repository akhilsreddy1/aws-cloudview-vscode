import * as vscode from "vscode";
import {
  ListExecutionsCommand,
  GetExecutionHistoryCommand,
  type ExecutionListItem,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsScope, ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";
import { parseASL, type AslGraph } from "./aslParser";
import { overlayFromHistory, type ExecutionOverlay } from "./executionOverlay";

/**
 * Step Functions **visual graph** panel.
 *
 * Renders the ASL definition as a Cytoscape graph, and overlays any
 * selected execution's actually-taken path on top — visited states
 * coloured by outcome, transitions bolded, hover reveals input/output/error.
 *
 * Definition comes from the discoverer's cached `rawJson.definition`; the
 * executions list + history come live from Step Functions. Panels are
 * keyed by state machine ARN so re-opening reveals the existing one.
 */
export class StepFunctionsGraphPanel {
  private static panels = new Map<string, StepFunctionsGraphPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly stateMachineArn: string;
  private readonly name: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.stateMachineArn = resource.arn;
    this.name = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewSfnGraph",
      `SFN Graph: ${this.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.platform.extensionContext.extensionUri, "media"),
        ],
      },
    );

    this.panel.onDidDispose(() => StepFunctionsGraphPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          await this.loadExecutions();
        } else if (msg.type === "refreshExecutions") {
          await this.loadExecutions();
        } else if (msg.type === "selectExecution" && typeof msg.executionArn === "string") {
          await this.loadOverlay(msg.executionArn);
        } else if (msg.type === "clearOverlay") {
          void this.panel.webview.postMessage({ type: "overlay", overlay: null, executionArn: null });
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = StepFunctionsGraphPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new StepFunctionsGraphPanel(platform, resource);
    StepFunctionsGraphPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<AwsScope | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadExecutions(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);
    try {
      const resp = await this.platform.scheduler.run("sfn", "ListExecutions", () =>
        client.send(new ListExecutionsCommand({ stateMachineArn: this.stateMachineArn, maxResults: 25 })),
      );
      const executions = (resp.executions ?? []).map(serializeExecution);
      void this.panel.webview.postMessage({ type: "executionsList", executions });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "executionsList", executions: [], error: message });
    }
  }

  private async loadOverlay(executionArn: string): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.sfn(scope);
    try {
      const events: HistoryEvent[] = [];
      let nextToken: string | undefined;
      // Cap pages to keep large histories snappy — 500 events covers most real executions.
      for (let i = 0; i < 5; i += 1) {
        const resp = await this.platform.scheduler.run("sfn", "GetExecutionHistory", () =>
          client.send(new GetExecutionHistoryCommand({
            executionArn,
            maxResults: 100,
            includeExecutionData: true,
            nextToken,
          })),
        );
        for (const ev of resp.events ?? []) events.push(ev);
        nextToken = resp.nextToken;
        if (!nextToken) break;
      }
      const overlay = overlayFromHistory(events);
      void this.panel.webview.postMessage({
        type: "overlay",
        overlay,
        executionArn,
        truncated: Boolean(nextToken),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`Loading execution history failed: ${message}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.name);
    const arn = escapeHtml(this.stateMachineArn);
    const region = escapeHtml(this.resource.region);
    const smType = escapeHtml((this.resource.rawJson.StateMachineType as string) ?? "STANDARD");

    // Parse the cached ASL definition into a graph up-front. On parse failure
    // we still render the panel — the empty state explains what happened so
    // the user can re-discover to refresh a stale/malformed definition.
    let graph: AslGraph = { nodes: [], edges: [] };
    let parseError = "";
    const definitionStr = this.resource.rawJson.definition as string | undefined;
    if (definitionStr) {
      try {
        graph = parseASL(definitionStr);
      } catch (err) {
        parseError = `Could not parse state machine definition: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      parseError = "No definition found in the local cache. Run CloudView: Refresh Resources.";
    }

    // Convert into Cytoscape element JSON.
    const elements: Array<Record<string, unknown>> = [];
    // Compound parents first so children can reference them.
    for (const node of graph.nodes.filter((n) => graph.nodes.some((c) => c.parent === n.id))) {
      elements.push({
        group: "nodes",
        data: { id: node.id, label: node.name, type: node.type, isCompound: true },
        classes: `compound type-${node.type}`,
      });
    }
    for (const node of graph.nodes) {
      const isCompound = graph.nodes.some((c) => c.parent === node.id);
      if (isCompound) continue; // already emitted
      const data: Record<string, unknown> = {
        id: node.id,
        label: node.name,
        type: node.type,
        isStart: Boolean(node.isStart),
        isEnd: Boolean(node.isEnd),
      };
      if (node.parent) data.parent = node.parent;
      elements.push({
        group: "nodes",
        data,
        classes:
          `type-${node.type}` +
          (node.isStart ? " start" : "") +
          (node.isEnd ? " end" : ""),
      });
    }
    for (const edge of graph.edges) {
      const classes: string[] = [];
      if (edge.isChoice) classes.push("choice");
      if (edge.isCatch) classes.push("catch");
      elements.push({
        group: "edges",
        data: {
          id: `${edge.source}->${edge.target}::${edge.label ?? ""}`,
          source: edge.source,
          target: edge.target,
          label: edge.label ?? "",
        },
        classes: classes.join(" "),
      });
    }

    // Cytoscape asset URIs (webview-safe).
    const asset = (file: string) =>
      this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.platform.extensionContext.extensionUri, "media", file),
      );
    const cyUri = asset("cytoscape.min.js");
    const layoutBaseUri = asset("layout-base.js");
    const coseBaseUri = asset("cose-base.js");
    const fcoseUri = asset("cytoscape-fcose.js");

    const elementsJson = JSON.stringify(elements);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>SFN Graph: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #C925D1; font-size: 20px; }
    .meta { display: flex; gap: 14px; margin-top: 4px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; background: #f3e8ff; color: #6b21a8; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }
    .btn.primary { background: rgb(99, 102, 241); border-color: rgb(99, 102, 241); color: #fff; }
    .btn.primary:hover { background: rgb(79, 70, 229); border-color: rgb(79, 70, 229); }
    .legend { margin-left: auto; display: flex; gap: 10px; font-size: 10px; color: var(--muted); align-items: center; }
    .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }

    .body { flex: 1; display: flex; overflow: hidden; }

    .side { width: 300px; min-width: 240px; border-right: 1px solid var(--border); background: var(--surface); overflow: auto; flex-shrink: 0; }
    .side-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); padding: 10px 14px 6px; }
    .exec-row { padding: 8px 14px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; }
    .exec-row:hover { background: var(--surface-2); }
    .exec-row.active { background: rgba(99, 102, 241, 0.10); border-left: 3px solid rgb(99, 102, 241); padding-left: 11px; }
    .exec-name { font-family: 'SF Mono','Fira Code',monospace; font-size: 11px; color: var(--text); word-break: break-all; }
    .exec-meta { display: flex; gap: 8px; margin-top: 4px; font-size: 10px; color: var(--muted); align-items: center; }
    .badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: .3px; }
    .badge.SUCCEEDED { background: #dcfce7; color: #166534; }
    .badge.FAILED, .badge.TIMED_OUT, .badge.ABORTED { background: #fee2e2; color: #991b1b; }
    .badge.RUNNING { background: #dbeafe; color: #1e40af; }

    #cy-container { flex: 1; background: var(--surface); position: relative; }
    #cy { width: 100%; height: 100%; }

    .empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); text-align: center; padding: 40px; }
    .empty .icon { font-size: 32px; margin-bottom: 8px; }

    /* Floating detail panel — shown on node click. */
    .node-detail {
      position: absolute; right: 12px; top: 12px; width: 320px; max-height: 70%;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 10px 14px; overflow: auto; box-shadow: 0 2px 8px rgba(0,0,0,.08);
      display: none; font-size: 12px;
    }
    .node-detail.show { display: block; }
    .node-detail .close { position: absolute; right: 8px; top: 6px; background: transparent; border: 0; font-size: 16px; color: var(--muted); cursor: pointer; }
    .node-detail h4 { font-size: 13px; margin: 0 0 4px; color: var(--text); }
    .node-detail .sub { font-size: 10px; color: var(--muted); margin-bottom: 8px; }
    .node-detail pre { background: var(--surface-2); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 11px; line-height: 1.4; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 4px 0 8px; }
    .node-detail .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-top: 8px; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">⇢</span>
      <span>${name}</span>
      <span class="pill">${smType}</span>
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
      <span id="overlay-status"></span>
    </div>
  </div>

  <div class="error-banner" id="error-banner">${parseError ? escapeHtml(parseError) : ""}</div>

  <div class="toolbar">
    <button class="btn" id="refresh-btn">↻ Refresh executions</button>
    <button class="btn" id="fit-btn">Fit to view</button>
    <button class="btn" id="clear-btn">Clear overlay</button>
    <span class="legend">
      <span><span class="dot" style="background:#16a34a"></span>succeeded</span>
      <span><span class="dot" style="background:#dc2626"></span>failed</span>
      <span><span class="dot" style="background:#d97706"></span>timed-out / running</span>
      <span><span class="dot" style="background:#9ca3af"></span>unvisited</span>
    </span>
  </div>

  <div class="body">
    <div class="side">
      <div class="side-title">Recent executions</div>
      <div id="exec-list"><div style="padding:14px;font-size:12px;color:var(--muted);">Loading…</div></div>
    </div>
    <div id="cy-container">
      ${parseError ? `<div class="empty"><div class="icon">⚠️</div><div>${escapeHtml(parseError)}</div></div>` : ""}
      <div id="cy"></div>
      <div class="node-detail" id="node-detail">
        <button class="close" id="node-close">×</button>
        <h4 id="nd-name"></h4>
        <div class="sub" id="nd-sub"></div>
        <div id="nd-body"></div>
      </div>
    </div>
  </div>

  <script nonce="${n}" src="${cyUri}"></script>
  <script nonce="${n}" src="${layoutBaseUri}"></script>
  <script nonce="${n}" src="${coseBaseUri}"></script>
  <script nonce="${n}" src="${fcoseUri}"></script>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const ELEMENTS = ${elementsJson};
    let cy = null;
    let currentExecutionArn = null;
    let currentOverlay = null;

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function fmtTs(iso){ if(!iso) return '—'; try { return new Date(iso).toLocaleString(); } catch(_) { return String(iso); } }
    function fmtDurMs(ms){ if(!ms || !isFinite(ms) || ms<0) return ''; if(ms<1000) return ms+'ms'; if(ms<60000) return (ms/1000).toFixed(1)+'s'; const m=Math.floor(ms/60000); const s=Math.floor((ms%60000)/1000); return m+'m '+s+'s'; }
    function showError(msg){ const el=document.getElementById('error-banner'); el.textContent=msg; el.style.display='block'; setTimeout(function(){el.style.display='none';}, 9000); }

    /* ── Cytoscape init ────────────────────────────────────────────────────── */
    if (window.cytoscape && ELEMENTS.length > 0) {
      if (window.cytoscapeFcose) { window.cytoscape.use(window.cytoscapeFcose); }
      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: ELEMENTS,
        style: [
          { selector: 'node',
            style: {
              'label': 'data(label)', 'font-size': '11px',
              'text-valign': 'center', 'text-halign': 'center',
              'color': '#0f172a', 'font-weight': 600,
              'background-color': '#e5e7eb',
              'border-width': 1, 'border-color': '#9ca3af',
              'width': 'label', 'height': 32, 'padding': '10px', 'shape': 'round-rectangle',
              'text-max-width': '160px', 'text-wrap': 'wrap',
            }
          },
          { selector: 'node.type-Task', style: { 'background-color': '#dbeafe', 'border-color': '#1e40af' } },
          { selector: 'node.type-Choice', style: { 'background-color': '#fef3c7', 'border-color': '#92400e', 'shape': 'diamond', 'height': 60, 'width': 80 } },
          { selector: 'node.type-Parallel', style: { 'background-color': '#ede9fe', 'border-color': '#5b21b6' } },
          { selector: 'node.type-Map', style: { 'background-color': '#dcfce7', 'border-color': '#166534' } },
          { selector: 'node.type-Wait', style: { 'background-color': '#f3f4f6', 'border-color': '#6b7280' } },
          { selector: 'node.type-Pass', style: { 'background-color': '#f1f5f9', 'border-color': '#475569' } },
          { selector: 'node.type-Succeed', style: { 'background-color': '#16a34a', 'color': '#fff', 'border-color': '#166534', 'shape': 'ellipse' } },
          { selector: 'node.type-Fail', style: { 'background-color': '#dc2626', 'color': '#fff', 'border-color': '#991b1b', 'shape': 'ellipse' } },
          { selector: 'node.start', style: { 'border-width': 3, 'border-color': '#1e40af' } },
          { selector: 'node.compound', style: { 'background-opacity': 0.15, 'border-width': 2, 'border-style': 'dashed', 'padding': '20px', 'text-valign': 'top', 'text-halign': 'center', 'font-size': '10px', 'text-margin-y': -6 } },
          /* Overlay states */
          { selector: 'node.outcome-succeeded', style: { 'background-color': '#dcfce7', 'border-color': '#16a34a', 'border-width': 3 } },
          { selector: 'node.outcome-failed',    style: { 'background-color': '#fee2e2', 'border-color': '#dc2626', 'border-width': 3 } },
          { selector: 'node.outcome-timed-out', style: { 'background-color': '#fef3c7', 'border-color': '#d97706', 'border-width': 3 } },
          { selector: 'node.outcome-aborted',   style: { 'background-color': '#f3f4f6', 'border-color': '#6b7280', 'border-width': 3 } },
          { selector: 'node.outcome-running',   style: { 'background-color': '#dbeafe', 'border-color': '#1e40af', 'border-width': 3, 'border-style': 'dashed' } },
          { selector: 'node.dimmed', style: { 'opacity': 0.28 } },
          /* Edges */
          { selector: 'edge',
            style: {
              'width': 1.5, 'line-color': '#9ca3af',
              'target-arrow-color': '#9ca3af', 'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'label': 'data(label)', 'font-size': '9px', 'color': '#6b7280',
              'text-background-color': '#fff', 'text-background-opacity': 0.9,
              'text-background-padding': '2px', 'text-rotation': 'autorotate',
            }
          },
          { selector: 'edge.choice', style: { 'line-style': 'dashed' } },
          { selector: 'edge.catch',  style: { 'line-color': '#dc2626', 'target-arrow-color': '#dc2626', 'line-style': 'dashed' } },
          { selector: 'edge.taken',  style: { 'width': 3, 'line-color': '#1e40af', 'target-arrow-color': '#1e40af' } },
          { selector: 'edge.dimmed', style: { 'opacity': 0.28 } },
        ],
        layout: { name: 'fcose', animate: false, quality: 'default', nodeSeparation: 90, idealEdgeLength: 120, packComponents: true },
        wheelSensitivity: 0.2,
      });

      cy.on('tap', 'node', function(e) { showNodeDetail(e.target); });
      cy.on('tap', function(e) { if (e.target === cy) hideNodeDetail(); });
    } else if (ELEMENTS.length === 0) {
      // Parse error already surfaces via .empty overlay above.
    }

    /* ── Executions list ─────────────────────────────────────────────────── */
    function renderExecList(execs, error) {
      const listEl = document.getElementById('exec-list');
      if (error) {
        listEl.innerHTML = '<div style="padding:14px;font-size:11px;color:#b91c1c;">' + esc(error) + '</div>';
        return;
      }
      if (!execs || execs.length === 0) {
        listEl.innerHTML = '<div style="padding:14px;font-size:11px;color:var(--muted);">No executions yet.</div>';
        return;
      }
      listEl.innerHTML = execs.map(function(e) {
        const cls = 'exec-row' + (e.executionArn === currentExecutionArn ? ' active' : '');
        return '<div class="' + cls + '" data-arn="' + esc(e.executionArn) + '">' +
          '<div class="exec-name">' + esc(e.name) + '</div>' +
          '<div class="exec-meta">' +
            '<span class="badge ' + esc(e.status || '') + '">' + esc((e.status || '').toLowerCase()) + '</span>' +
            '<span>' + esc(fmtTs(e.startDate)) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      listEl.querySelectorAll('.exec-row').forEach(function(row) {
        row.addEventListener('click', function() {
          const arn = row.getAttribute('data-arn');
          vscode.postMessage({ type: 'selectExecution', executionArn: arn });
        });
      });
    }

    /* ── Overlay application ─────────────────────────────────────────────── */
    function applyOverlay(overlay, executionArn) {
      currentOverlay = overlay;
      currentExecutionArn = executionArn;

      // Re-render exec list to reflect .active row.
      document.querySelectorAll('.exec-row').forEach(function(row) {
        row.classList.toggle('active', row.getAttribute('data-arn') === executionArn);
      });

      const statusEl = document.getElementById('overlay-status');
      if (!overlay) {
        statusEl.textContent = '';
        if (cy) {
          cy.nodes().removeClass('outcome-succeeded outcome-failed outcome-timed-out outcome-aborted outcome-running dimmed');
          cy.edges().removeClass('taken dimmed');
        }
        return;
      }

      statusEl.innerHTML = '<span class="label">Overlay:</span> <span class="badge ' + esc(overlay.finalStatus) + '">' + esc(overlay.finalStatus.toLowerCase()) + '</span>';

      if (!cy) return;
      // Dim everything, then re-highlight the visited states / edges.
      cy.nodes().addClass('dimmed').removeClass('outcome-succeeded outcome-failed outcome-timed-out outcome-aborted outcome-running');
      cy.edges().addClass('dimmed').removeClass('taken');

      Object.keys(overlay.perState).forEach(function(name) {
        const outcome = overlay.perState[name].outcome;
        // Match by state name (data.label), applying to all nodes that share
        // the name (handles Parallel branches with duplicate state names).
        cy.nodes().filter(function(n) { return n.data('label') === name; }).forEach(function(n) {
          n.removeClass('dimmed').addClass('outcome-' + outcome);
        });
      });
      (overlay.takenEdges || []).forEach(function(edge) {
        cy.edges().filter(function(ed) {
          const s = cy.getElementById(ed.data('source'));
          const t = cy.getElementById(ed.data('target'));
          return s && t && s.data('label') === edge.from && t.data('label') === edge.to;
        }).forEach(function(e) {
          e.removeClass('dimmed').addClass('taken');
          // Un-dim the endpoints too if they weren't already highlighted.
          cy.getElementById(e.data('source')).removeClass('dimmed');
          cy.getElementById(e.data('target')).removeClass('dimmed');
        });
      });
    }

    /* ── Node detail panel ───────────────────────────────────────────────── */
    function showNodeDetail(node) {
      const detail = document.getElementById('node-detail');
      const name = node.data('label');
      const type = node.data('type');
      document.getElementById('nd-name').textContent = name;
      document.getElementById('nd-sub').textContent = type;

      let bodyHtml = '';
      if (currentOverlay && currentOverlay.perState[name]) {
        const st = currentOverlay.perState[name];
        bodyHtml += '<div class="label">Outcome</div><div><span class="badge ' + esc(st.outcome === 'succeeded' ? 'SUCCEEDED' : st.outcome === 'failed' ? 'FAILED' : st.outcome === 'timed-out' ? 'TIMED_OUT' : 'RUNNING') + '">' + esc(st.outcome) + '</span></div>';
        if (st.entered && st.exited) bodyHtml += '<div class="label">Duration</div><div>' + esc(fmtDurMs(st.exited - st.entered)) + '</div>';
        if (st.error) bodyHtml += '<div class="label">Error</div><div>' + esc(st.error) + '</div>';
        if (st.cause) bodyHtml += '<div class="label">Cause</div><pre>' + esc(st.cause) + '</pre>';
        if (st.input) bodyHtml += '<div class="label">Input</div><pre>' + esc(prettyJson(st.input)) + '</pre>';
        if (st.output) bodyHtml += '<div class="label">Output</div><pre>' + esc(prettyJson(st.output)) + '</pre>';
      } else {
        bodyHtml += '<div class="sub">Pick an execution on the left to see this state\\'s input/output/outcome.</div>';
      }
      document.getElementById('nd-body').innerHTML = bodyHtml;
      detail.classList.add('show');
    }
    function hideNodeDetail() {
      document.getElementById('node-detail').classList.remove('show');
    }
    function prettyJson(s) {
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch(_) { return String(s); }
    }
    document.getElementById('node-close').addEventListener('click', hideNodeDetail);

    /* ── Toolbar ─────────────────────────────────────────────────────────── */
    document.getElementById('refresh-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'refreshExecutions' });
    });
    document.getElementById('fit-btn').addEventListener('click', function() {
      if (cy) cy.fit(undefined, 30);
    });
    document.getElementById('clear-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'clearOverlay' });
    });

    /* ── Message channel ─────────────────────────────────────────────────── */
    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (m.type === 'executionsList') { renderExecList(m.executions, m.error); }
      else if (m.type === 'overlay') { applyOverlay(m.overlay, m.executionArn); }
      else if (m.type === 'error') { showError(m.message); }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializeExecution(e: ExecutionListItem): {
  executionArn: string;
  name: string;
  status: string;
  startDate?: string;
  stopDate?: string;
} {
  return {
    executionArn: e.executionArn ?? "",
    name: e.name ?? "",
    status: e.status ?? "",
    startDate: e.startDate ? e.startDate.toISOString() : undefined,
    stopDate: e.stopDate ? e.stopDate.toISOString() : undefined,
  };
}
