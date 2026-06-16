import * as vscode from "vscode";
import {
  ListExportsCommand,
  ListImportsCommand,
  GetTemplateCommand,
  type Export,
} from "@aws-sdk/client-cloudformation";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * CloudFormation stack dependencies drilldown:
 *   Stack
 *     ├─ Exports this stack publishes  → consumers (via ListImports)
 *     ├─ Imports this stack consumes   ← producers (parsed from template)
 *     └─ Nested-stack chain (parent + children, from the local cache)
 *
 * Live API surface (kept light):
 *   1. `ListExports` — region-wide; used to map ExportName → exporting stack
 *      for both directions of the lookup.
 *   2. `ListImports({ExportName})` — per export this stack publishes.
 *   3. `GetTemplate({TemplateStage: "Original"})` — the original template
 *      retains `Fn::ImportValue` calls; the processed template would have
 *      them substituted. We grep the text for refs.
 *
 * Nested-stack relationships come from the cached `ParentStackId` field
 * populated by the discoverer — no extra round-trip needed.
 */
export class CfnStackDependenciesPanel {
  private static panels = new Map<string, CfnStackDependenciesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly stackName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.stackName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewCfnDependencies",
      `CFN: ${this.stackName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => CfnStackDependenciesPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "refresh") {
          await this.loadDependencies();
        } else if (msg.type === "openStackGraph" && typeof msg.arn === "string") {
          await vscode.commands.executeCommand("cloudView.openGraphView.fromArn", msg.arn);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    if (resource.type !== ResourceTypes.cfnStack) {
      void vscode.window.showWarningMessage("Dependencies view is only available for CloudFormation stacks.");
      return;
    }
    const existing = CfnStackDependenciesPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new CfnStackDependenciesPanel(platform, resource);
    CfnStackDependenciesPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadDependencies(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    void this.panel.webview.postMessage({ type: "loading" });
    const client = await this.platform.awsClientFactory.cloudformation(scope);

    // ── 1. Region-wide exports → for both directions of the lookup. ────────
    const allExports: Export[] = [];
    try {
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const resp = await this.platform.scheduler.run("cloudformation", "ListExports", () =>
          client.send(new ListExportsCommand({ NextToken: nextToken }))
        );
        for (const e of resp.Exports ?? []) allExports.push(e);
        nextToken = resp.NextToken;
        pages += 1;
        // Soft cap — accounts with thousands of exports are rare; keep the UI snappy.
        if (pages >= 10) break;
      } while (nextToken);
    } catch (err) {
      this.platform.logger.warn(`ListExports failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const exportByName = new Map<string, Export>();
    for (const e of allExports) if (e.Name) exportByName.set(e.Name, e);

    // ── 2. This stack's exports → who imports each one. ───────────────────
    const myOutputs = (this.resource.rawJson.Outputs as Array<{ Key?: string; Value?: string; Description?: string; ExportName?: string }> | undefined) ?? [];
    const exportsPublished: PublishedExport[] = [];
    for (const out of myOutputs) {
      if (!out.ExportName) continue;
      let importingStacks: string[] = [];
      try {
        const resp = await this.platform.scheduler.run("cloudformation", "ListImports", () =>
          client.send(new ListImportsCommand({ ExportName: out.ExportName }))
        );
        importingStacks = resp.Imports ?? [];
      } catch {
        // CloudFormation throws if no stacks import the export — treat as empty.
      }
      exportsPublished.push({
        outputKey: out.Key ?? "(unknown)",
        exportName: out.ExportName,
        value: out.Value ?? "",
        description: out.Description,
        importingStacks,
      });
    }

    // ── 3. This stack's imports → grep the original template. ─────────────
    let templateText = "";
    try {
      const resp = await this.platform.scheduler.run("cloudformation", "GetTemplate", () =>
        client.send(new GetTemplateCommand({ StackName: this.stackName, TemplateStage: "Original" }))
      );
      templateText = resp.TemplateBody ?? "";
    } catch (err) {
      this.platform.logger.warn(`GetTemplate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const importedNames = extractImportValueRefs(templateText);
    const importsConsumed: ConsumedImport[] = importedNames.map((name) => {
      const src = exportByName.get(name);
      return {
        exportName: name,
        producingStackArn: src?.ExportingStackId,
        producingStackName: src?.ExportingStackId ? stackNameFromArn(src.ExportingStackId) : undefined,
        value: src?.Value,
      };
    });

    // ── 4. Nested-stack chain from the cached `ParentStackId`. ─────────────
    const allStacks = await this.platform.resourceRepo.listByAccounts([this.resource.accountId], ["cloudformation"]);
    const inRegion = allStacks.filter((s) => s.region === this.resource.region && s.type === ResourceTypes.cfnStack);
    const myStackId = (this.resource.rawJson.StackId as string | undefined) ?? this.resource.arn;
    const parentArn = this.resource.rawJson.ParentStackId as string | undefined;
    const parentNode = parentArn ? inRegion.find((s) => (s.rawJson.StackId as string) === parentArn || s.arn === parentArn) : undefined;
    const childNodes = inRegion.filter((s) => {
      const p = s.rawJson.ParentStackId as string | undefined;
      return p && (p === myStackId || p === this.resource.arn);
    });
    const nested: NestedSummary = {
      parent: parentNode ? { name: parentNode.name, arn: parentNode.arn, status: parentNode.rawJson.StackStatus as string | undefined } : undefined,
      children: childNodes.map((c) => ({ name: c.name, arn: c.arn, status: c.rawJson.StackStatus as string | undefined })),
    };

    void this.panel.webview.postMessage({
      type: "dependencies",
      data: { exportsPublished, importsConsumed, nested },
    });
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.stackName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const status = escapeHtml((this.resource.rawJson.StackStatus as string) ?? "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>CFN: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #DD3522; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }

    .content { flex: 1; overflow: auto; padding: 12px 20px; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    .tree-node { margin: 2px 0; }
    .node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius-sm); }
    .node-row:hover { background: var(--surface-2); }
    .twisty { width: 14px; text-align: center; cursor: pointer; color: var(--muted); user-select: none; flex-shrink: 0; }
    .twisty.leaf { visibility: hidden; }
    .children { margin-left: 18px; border-left: 1px solid var(--border); padding-left: 6px; }
    .children.collapsed { display: none; }

    .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; font-family: 'SF Mono','Fira Code',monospace; }
    .pill.export { background: #dcfce7; color: #166534; }
    .pill.import { background: #fef3c7; color: #92400e; }
    .pill.nested { background: #ede9fe; color: #5b21b6; }
    .pill.consumer { background: #dbeafe; color: #1e40af; cursor: pointer; }
    .pill.consumer:hover { background: #bfdbfe; }
    .pill.producer { background: #e0e7ff; color: #3730a3; cursor: pointer; }
    .pill.producer:hover { background: #c7d2fe; }
    .pill.unused { background: #f3f4f6; color: #6b7280; }
    .pill.unknown { background: #fee2e2; color: #991b1b; }

    .node-label { font-size: 13px; color: var(--text); font-family: 'SF Mono','Fira Code',monospace; }
    .node-sub { font-size: 11px; color: var(--muted); }
    .node-section { font-size: 13px; color: var(--text); font-weight: 600; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F517}</span>
      <span>${name}</span>
      ${status ? `<span class="pill nested">${status}</span>` : ""}
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
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F517}</div>
      <div>Loading stack dependencies…</div>
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

    function renderConsumerStack(stackArnOrName) {
      // The ListImports response actually returns stack names (not ARNs).
      // Render as a "consumer" pill; click to open in graph view.
      return '<span class="pill consumer" data-graph-arn="' + esc(stackArnOrName) + '" title="Open in graph view">' + esc(stackArnOrName) + '</span>';
    }
    function renderProducerStack(name, arn) {
      var label = name || arn || '(unknown)';
      if (!arn) return '<span class="pill unknown" title="Producer not found in the cache">' + esc(label) + '</span>';
      return '<span class="pill producer" data-graph-arn="' + esc(arn) + '" title="Open in graph view">' + esc(label) + '</span>';
    }

    function renderExportsBranch(exportsPublished) {
      var children = exportsPublished.map(function(e) {
        var consumerHtml;
        if (e.importingStacks.length === 0) {
          consumerHtml = '<div class="node-row"><span class="twisty leaf">▼</span><span class="pill unused">not imported anywhere</span></div>';
        } else {
          var inner = e.importingStacks.map(function(s) {
            return '<div class="node-row"><span class="twisty leaf">▼</span>' + renderConsumerStack(s) + '</div>';
          }).join('');
          consumerHtml = inner;
        }
        return '<div class="tree-node">' +
          '<div class="node-row">' +
            '<span class="twisty" data-toggle>▼</span>' +
            '<span class="pill export">' + esc(e.exportName) + '</span>' +
            '<span class="node-sub">(output: ' + esc(e.outputKey) + ')</span>' +
          '</div>' +
          '<div class="children">' + consumerHtml + '</div>' +
        '</div>';
      }).join('');
      return '<div class="tree-node">' +
        '<div class="node-row">' +
          '<span class="twisty" data-toggle>▼</span>' +
          '<span class="node-section">Exports this stack publishes (' + exportsPublished.length + ')</span>' +
        '</div>' +
        '<div class="children">' + (exportsPublished.length ? children : '<div class="node-row"><span class="twisty leaf">▼</span><span class="node-sub">(this stack has no exports)</span></div>') + '</div>' +
      '</div>';
    }

    function renderImportsBranch(importsConsumed) {
      var children = importsConsumed.map(function(i) {
        return '<div class="tree-node">' +
          '<div class="node-row">' +
            '<span class="twisty leaf">▼</span>' +
            '<span class="pill import">' + esc(i.exportName) + '</span>' +
            '<span class="node-sub">←</span>' +
            renderProducerStack(i.producingStackName, i.producingStackArn) +
          '</div>' +
        '</div>';
      }).join('');
      return '<div class="tree-node">' +
        '<div class="node-row">' +
          '<span class="twisty" data-toggle>▼</span>' +
          '<span class="node-section">Imports this stack consumes (' + importsConsumed.length + ')</span>' +
        '</div>' +
        '<div class="children">' + (importsConsumed.length ? children : '<div class="node-row"><span class="twisty leaf">▼</span><span class="node-sub">(this stack uses no Fn::ImportValue)</span></div>') + '</div>' +
      '</div>';
    }

    function renderNestedBranch(nested) {
      var parts = [];
      if (nested.parent) {
        parts.push('<div class="node-row"><span class="twisty leaf">▼</span><span class="node-sub">Parent stack:</span>' + renderProducerStack(nested.parent.name, nested.parent.arn) + '<span class="node-sub">' + esc(nested.parent.status || '') + '</span></div>');
      }
      if (nested.children && nested.children.length) {
        parts.push('<div class="node-row"><span class="twisty leaf">▼</span><span class="node-sub">Children (' + nested.children.length + '):</span></div>');
        for (var i = 0; i < nested.children.length; i++) {
          var c = nested.children[i];
          parts.push('<div class="node-row" style="padding-left:18px;"><span class="twisty leaf">▼</span>' + renderProducerStack(c.name, c.arn) + '<span class="node-sub">' + esc(c.status || '') + '</span></div>');
        }
      }
      if (parts.length === 0) {
        parts.push('<div class="node-row"><span class="twisty leaf">▼</span><span class="node-sub">(stack has no parent or children — standalone)</span></div>');
      }
      return '<div class="tree-node">' +
        '<div class="node-row">' +
          '<span class="twisty" data-toggle>▼</span>' +
          '<span class="node-section">Nested-stack chain</span>' +
        '</div>' +
        '<div class="children">' + parts.join('') + '</div>' +
      '</div>';
    }

    function renderTree(data) {
      emptyEl.style.display = 'none';
      treeEl.style.display = 'block';
      treeEl.innerHTML =
        renderExportsBranch(data.exportsPublished || []) +
        renderImportsBranch(data.importsConsumed || []) +
        renderNestedBranch(data.nested || { children: [] });
      wireTwisties();
      wireGraphLinks();
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
    function wireGraphLinks() {
      treeEl.querySelectorAll('[data-graph-arn]').forEach(function(el){
        el.onclick = function(){ vscode.postMessage({ type:'openStackGraph', arn: el.getAttribute('data-graph-arn') }); };
      });
    }

    refreshBtn.onclick = function(){ refreshBtn.disabled = true; refreshBtn.textContent = '…'; vscode.postMessage({ type:'refresh' }); };
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
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading stack dependencies…';
        treeEl.style.display = 'none';
      } else if (m.type === 'dependencies') {
        refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh';
        renderTree(m.data || { exportsPublished:[], importsConsumed:[], nested:{children:[]} });
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

// ─── Serialised tree-node types (server → webview) ───────────────────────────

interface PublishedExport {
  outputKey: string;
  exportName: string;
  value: string;
  description?: string;
  importingStacks: string[];
}
interface ConsumedImport {
  exportName: string;
  producingStackArn?: string;
  producingStackName?: string;
  value?: string;
}
interface NestedSummary {
  parent?: { name: string; arn: string; status?: string };
  children: Array<{ name: string; arn: string; status?: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pull `Fn::ImportValue` export-name references out of a CloudFormation
 * template body. Handles both JSON (`"Fn::ImportValue": "Foo"`) and the
 * YAML short form (`!ImportValue Foo`). Imports whose name is computed at
 * deploy time (Fn::Sub / Fn::Join) are skipped — those would require a
 * deeper parse than a regex.
 */
function extractImportValueRefs(template: string): string[] {
  if (!template) return [];
  const names = new Set<string>();

  // JSON: "Fn::ImportValue": "ExactName"
  const jsonRx = /"Fn::ImportValue"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRx.exec(template)) !== null) names.add(m[1]);

  // YAML short form: !ImportValue ExactName
  const yamlRx = /!ImportValue\s+([A-Za-z0-9:_/.-]+)/g;
  while ((m = yamlRx.exec(template)) !== null) names.add(m[1]);

  // YAML long form: ImportValue: ExactName (after Fn:: prefix expanded)
  const yamlLongRx = /Fn::ImportValue:\s*([A-Za-z0-9:_/.-]+)/g;
  while ((m = yamlLongRx.exec(template)) !== null) names.add(m[1]);

  return [...names].sort();
}

/** Pull the stack name out of a stack ARN. */
function stackNameFromArn(arn: string): string {
  // arn:aws:cloudformation:region:account:stack/<name>/<uuid>
  const parts = arn.split("/");
  return parts.length >= 2 ? parts[1] : arn;
}
