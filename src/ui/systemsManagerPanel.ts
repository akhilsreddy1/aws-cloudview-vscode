import * as vscode from "vscode";
import {
  DescribeParametersCommand,
  GetParameterCommand,
  ListDocumentsCommand,
  SendCommandCommand,
  StartAutomationExecutionCommand,
  ListCommandsCommand,
  DescribeAutomationExecutionsCommand,
  type ParameterMetadata,
  type DocumentIdentifier,
  type Command,
  type AutomationExecutionMetadata,
} from "@aws-sdk/client-ssm";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsProfileSession } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES, AWS_ICONS, DEFAULT_ICON } from "../views/webviewToolkit";
import { readCloudViewConfiguration } from "../core/config";
import { requireSelectedSessions } from "./profileGuards";

interface PanelScope {
  session: AwsProfileSession;
  region: string;
}

const LIST_PAGE_MAX = 5; // cap pagination per tab to keep the UI responsive

/** Normalise a JSON params object into SSM's `Record<string, string[]>` shape. */
function normalizeParams(raw: unknown): Record<string, string[]> | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map((x) => String(x));
    else out[k] = [String(v)];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Systems Manager panel — a webview with three tabs:
 *  1. **Parameters**: `DescribeParameters` to list, `GetParameter` (with
 *     decryption) to view a value on demand (masked until revealed).
 *  2. **Documents**: `ListDocuments` (filterable by owner) with the ability to
 *     trigger a run — `SendCommand` for Command documents (against instance
 *     ids) or `StartAutomationExecution` for Automation documents.
 *  3. **Executions**: a unified view of recent `ListCommands` (Run Command)
 *     and `DescribeAutomationExecutions` (Automation) with their statuses.
 *
 * Profile + region are chosen on open (like the Athena runner). Parameter
 * values are fetched on demand and never persisted.
 */
export class SystemsManagerPanel {
  private static panels = new Map<string, SystemsManagerPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly key: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private scope: PanelScope,
  ) {
    this.key = `${scope.session.profileName}|${scope.session.accountId}|${scope.region}`;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewSystemsManager",
      `Systems Manager: ${scope.session.profileName} · ${scope.region}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => SystemsManagerPanel.panels.delete(this.key));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          void this.panel.webview.postMessage({
            type: "scope",
            profileName: this.scope.session.profileName,
            accountId: this.scope.session.accountId,
            region: this.scope.region,
          });
          await this.loadParameters();
        } else if (msg.type === "loadParameters") {
          await this.loadParameters();
        } else if (msg.type === "getParameter" && typeof msg.name === "string") {
          await this.getParameterValue(msg.name);
        } else if (msg.type === "loadDocuments") {
          await this.loadDocuments(typeof msg.owner === "string" ? msg.owner : "Self");
        } else if (msg.type === "triggerDocument" && typeof msg.name === "string") {
          await this.triggerDocument(
            msg.name,
            typeof msg.docType === "string" ? msg.docType : "Command",
            typeof msg.parameters === "string" ? msg.parameters : "",
            typeof msg.instanceIds === "string" ? msg.instanceIds : "",
          );
        } else if (msg.type === "loadExecutions") {
          await this.loadExecutions();
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform): Promise<void> {
    const sessions = await requireSelectedSessions(platform, "open Systems Manager");
    if (!sessions) return;

    let session = sessions[0];
    if (sessions.length > 1) {
      const picked = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.profileName, description: s.accountId, _session: s })),
        { title: "Systems Manager: pick a profile", placeHolder: "Profile" },
      );
      if (!picked) return;
      session = picked._session;
    }

    const cfg = readCloudViewConfiguration();
    const realRegions = cfg.regions.filter((r) => r !== "global");
    let region = session.defaultRegion ?? realRegions[0] ?? "us-east-1";
    if (realRegions.length > 1) {
      const picked = await vscode.window.showQuickPick(realRegions, {
        title: "Systems Manager: pick a region",
        placeHolder: "Region",
      });
      if (!picked) return;
      region = picked;
    }

    const key = `${session.profileName}|${session.accountId}|${region}`;
    const existing = SystemsManagerPanel.panels.get(key);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new SystemsManagerPanel(platform, { session, region });
    SystemsManagerPanel.panels.set(key, instance);
  }

  private get awsScope() {
    return {
      profileName: this.scope.session.profileName,
      accountId: this.scope.session.accountId,
      region: this.scope.region,
    };
  }

  // ─── Parameters ─────────────────────────────────────────────────────────────

  private async loadParameters(): Promise<void> {
    const client = await this.platform.awsClientFactory.ssm(this.awsScope);
    const params: ParameterMetadata[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    try {
      do {
        const resp = await this.platform.scheduler.run("ssm", "DescribeParameters", () =>
          client.send(new DescribeParametersCommand({ NextToken: nextToken, MaxResults: 50 }))
        );
        for (const p of resp.Parameters ?? []) params.push(p);
        nextToken = resp.NextToken;
        pages += 1;
      } while (nextToken && pages < LIST_PAGE_MAX);
    } catch (err: unknown) {
      this.postError(`DescribeParameters failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    void this.panel.webview.postMessage({
      type: "parameters",
      truncated: Boolean(nextToken),
      rows: params.map((p) => ({
        name: p.Name ?? "",
        ptype: p.Type ?? "",
        tier: p.Tier ?? "",
        version: p.Version,
        lastModified: p.LastModifiedDate ? p.LastModifiedDate.toISOString() : undefined,
        description: p.Description ?? "",
      })),
    });
  }

  private async getParameterValue(name: string): Promise<void> {
    const client = await this.platform.awsClientFactory.ssm(this.awsScope);
    try {
      const resp = await this.platform.scheduler.run("ssm", "GetParameter", () =>
        client.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
      );
      void this.panel.webview.postMessage({
        type: "parameterValue",
        name,
        value: resp.Parameter?.Value ?? "",
        ptype: resp.Parameter?.Type ?? "",
        version: resp.Parameter?.Version,
      });
    } catch (err: unknown) {
      this.postError(`GetParameter failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Documents ───────────────────────────────────────────────────────────────

  private async loadDocuments(owner: string): Promise<void> {
    const client = await this.platform.awsClientFactory.ssm(this.awsScope);
    const docs: DocumentIdentifier[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    try {
      do {
        const resp = await this.platform.scheduler.run("ssm", "ListDocuments", () =>
          client.send(new ListDocumentsCommand({
            NextToken: nextToken,
            MaxResults: 50,
            Filters: owner === "All" ? undefined : [{ Key: "Owner", Values: [owner] }],
          }))
        );
        for (const d of resp.DocumentIdentifiers ?? []) docs.push(d);
        nextToken = resp.NextToken;
        pages += 1;
      } while (nextToken && pages < LIST_PAGE_MAX);
    } catch (err: unknown) {
      this.postError(`ListDocuments failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    void this.panel.webview.postMessage({
      type: "documents",
      owner,
      truncated: Boolean(nextToken),
      rows: docs.map((d) => ({
        name: d.Name ?? "",
        docType: d.DocumentType ?? "",
        format: d.DocumentFormat ?? "",
        owner: d.Owner ?? "",
        platforms: (d.PlatformTypes ?? []).join(", "),
        targetType: d.TargetType ?? "",
      })),
    });
  }

  private async triggerDocument(name: string, docType: string, parametersJson: string, instanceIdsRaw: string): Promise<void> {
    let parameters: Record<string, string[]> | undefined;
    if (parametersJson.trim()) {
      try {
        parameters = normalizeParams(JSON.parse(parametersJson));
      } catch (err: unknown) {
        this.postError(`Parameters must be a JSON object: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const isAutomation = docType === "Automation";
    const summary = isAutomation
      ? `Start an Automation execution of "${name}"?`
      : `Run command document "${name}"?`;
    const targetIds = instanceIdsRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const detail = isAutomation
      ? "This calls StartAutomationExecution and may create or modify resources depending on the document."
      : `Targets: ${targetIds.length ? targetIds.join(", ") : "(none — required for Run Command)"}\n\nThis calls SendCommand and executes on the target instances.`;

    const confirm = await vscode.window.showWarningMessage(
      summary, { modal: true, detail }, isAutomation ? "Start automation" : "Run command",
    );
    if (!confirm) return;

    const client = await this.platform.awsClientFactory.ssm(this.awsScope);
    try {
      if (isAutomation) {
        const resp = await this.platform.scheduler.run("ssm", "StartAutomationExecution", () =>
          client.send(new StartAutomationExecutionCommand({ DocumentName: name, Parameters: parameters }))
        );
        void vscode.window.showInformationMessage(`Started automation ${resp.AutomationExecutionId?.slice(0, 12) ?? ""}… for "${name}".`);
      } else {
        if (targetIds.length === 0) {
          this.postError("Run Command requires at least one target instance id.");
          return;
        }
        const resp = await this.platform.scheduler.run("ssm", "SendCommand", () =>
          client.send(new SendCommandCommand({ DocumentName: name, InstanceIds: targetIds, Parameters: parameters }))
        );
        void vscode.window.showInformationMessage(`Sent command ${resp.Command?.CommandId?.slice(0, 12) ?? ""}… for "${name}".`);
      }
      void this.panel.webview.postMessage({ type: "triggered", name });
      // Surface the new execution after a moment.
      setTimeout(() => void this.loadExecutions().catch(() => { /* best-effort */ }), 1500);
    } catch (err: unknown) {
      this.postError(`Trigger failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Executions (Run Command + Automation) ────────────────────────────────────

  private async loadExecutions(): Promise<void> {
    const client = await this.platform.awsClientFactory.ssm(this.awsScope);
    let commands: Command[] = [];
    let automations: AutomationExecutionMetadata[] = [];
    try {
      const [cmdResp, autoResp] = await Promise.all([
        this.platform.scheduler.run("ssm", "ListCommands", () =>
          client.send(new ListCommandsCommand({ MaxResults: 25 }))),
        this.platform.scheduler.run("ssm", "DescribeAutomationExecutions", () =>
          client.send(new DescribeAutomationExecutionsCommand({ MaxResults: 25 }))),
      ]);
      commands = cmdResp.Commands ?? [];
      automations = autoResp.AutomationExecutionMetadataList ?? [];
    } catch (err: unknown) {
      this.postError(`Loading executions failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const rows = [
      ...commands.map((c) => ({
        kind: "Run Command",
        id: c.CommandId ?? "",
        document: c.DocumentName ?? "",
        status: c.Status ?? "",
        started: c.RequestedDateTime ? c.RequestedDateTime.toISOString() : undefined,
        detail: `${c.CompletedCount ?? 0}/${c.TargetCount ?? 0} targets` + ((c.ErrorCount ?? 0) ? `, ${c.ErrorCount} errors` : ""),
        startedMs: c.RequestedDateTime ? c.RequestedDateTime.getTime() : 0,
      })),
      ...automations.map((a) => ({
        kind: "Automation",
        id: a.AutomationExecutionId ?? "",
        document: a.DocumentName ?? "",
        status: a.AutomationExecutionStatus ?? "",
        started: a.ExecutionStartTime ? a.ExecutionStartTime.toISOString() : undefined,
        detail: a.Mode ?? "",
        startedMs: a.ExecutionStartTime ? a.ExecutionStartTime.getTime() : 0,
      })),
    ].sort((x, y) => y.startedMs - x.startedMs);

    void this.panel.webview.postMessage({ type: "executions", rows });
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Systems Manager</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .cv-header { flex-shrink: 0; }

    .tabs { display: flex; gap: 2px; padding: 0 20px; background: var(--surface-2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .tab { padding: 9px 16px; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar select { background: var(--surface); border: 1px solid var(--border-2); color: var(--text); padding: 4px 8px; border-radius: var(--radius-sm); font-size: 12px; }
    .btn { background: var(--accent); color: #fff; border: none; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #e68a00; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }
    .trunc { font-size: 10px; color: #92400e; background: #fef3c7; padding: 2px 8px; border-radius: 10px; }

    .content { flex: 1; overflow: auto; background: var(--surface); }
    .pane { display: none; }
    .pane.active { display: block; }
    .empty { color: var(--light); padding: 40px; text-align: center; font-size: 13px; }

    table.t { border-collapse: collapse; font-size: 12px; width: 100%; }
    table.t thead th { background: var(--surface-2); position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--border); padding: 7px 10px; text-align: left; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; color: var(--text); white-space: nowrap; }
    table.t tbody td { padding: 5px 10px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: top; }
    table.t tbody tr:hover td { background: var(--surface-2); }
    .mono { font-family: 'SF Mono','Fira Code',Menlo,monospace; font-size: 11px; }
    .muted { color: var(--muted); }
    .row-btn { padding: 2px 8px; border-radius: 8px; border: 1px solid var(--border-2); background: transparent; color: var(--text); font-size: 11px; cursor: pointer; }
    .row-btn:hover { background: var(--surface-3); }
    .val-cell { font-family: 'SF Mono','Fira Code',Menlo,monospace; font-size: 11px; max-width: 420px; word-break: break-all; white-space: pre-wrap; }

    .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
    .st-Success, .st-SUCCEEDED, .st-Completed { background: #dcfce7; color: #166534; }
    .st-Failed, .st-FAILED, .st-Cancelled, .st-CANCELLED, .st-TimedOut { background: #fee2e2; color: #991b1b; }
    .st-InProgress, .st-Pending, .st-RUNNING, .st-Waiting { background: #fef3c7; color: #92400e; }

    /* Trigger form modal */
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; z-index: 10; }
    .overlay.show { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--radius); width: 520px; max-width: 92vw; padding: 16px 18px; }
    .modal h3 { margin: 0 0 4px; font-size: 14px; color: var(--text); }
    .modal .sub { font-size: 11px; color: var(--muted); margin-bottom: 12px; }
    .modal label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
    .modal textarea, .modal input { width: 100%; background: var(--surface-2); border: 1px solid var(--border-2); color: var(--text); padding: 7px 9px; border-radius: var(--radius-sm); font-size: 12px; font-family: 'SF Mono','Fira Code',Menlo,monospace; box-sizing: border-box; }
    .modal textarea { min-height: 90px; resize: vertical; }
    .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    .modal .hint { font-size: 10px; color: var(--muted); margin-top: 3px; }
    .field-instances { display: none; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="cv-header">
    <div class="cv-header-top">
      <div class="cv-service-icon">${AWS_ICONS["systemsmanager"] || DEFAULT_ICON}</div>
      <div class="cv-title-group">
        <div class="cv-service-title">Systems Manager</div>
        <div class="cv-service-subtitle">
          <span id="hdr-profile">…</span>
          <span class="cv-sep">•</span>
          <span id="hdr-account">…</span>
          <span class="cv-sep">•</span>
          <span id="hdr-region">…</span>
        </div>
      </div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="parameters">Parameters</div>
    <div class="tab" data-tab="documents">Documents</div>
    <div class="tab" data-tab="executions">Execution History</div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <!-- Parameters -->
  <div class="toolbar tab-toolbar" data-for="parameters">
    <button class="btn ghost" id="params-refresh">↻ Refresh</button>
    <span class="trunc" id="params-trunc" style="display:none;">showing first results</span>
    <span class="muted" id="params-count"></span>
  </div>
  <!-- Documents -->
  <div class="toolbar tab-toolbar" data-for="documents" style="display:none;">
    <label>Owner</label>
    <select id="docs-owner">
      <option value="Self">Self</option>
      <option value="Amazon">Amazon</option>
      <option value="All">All</option>
    </select>
    <button class="btn ghost" id="docs-refresh">↻ Refresh</button>
    <span class="trunc" id="docs-trunc" style="display:none;">showing first results</span>
    <span class="muted" id="docs-count"></span>
  </div>
  <!-- Executions -->
  <div class="toolbar tab-toolbar" data-for="executions" style="display:none;">
    <button class="btn ghost" id="execs-refresh">↻ Refresh</button>
    <span class="muted" id="execs-count"></span>
  </div>

  <div class="content">
    <div class="pane active" id="pane-parameters">
      <table class="t"><thead><tr><th>Name</th><th>Type</th><th>Tier</th><th>Version</th><th>Last Modified</th><th>Value</th></tr></thead>
      <tbody id="params-body"></tbody></table>
      <div class="empty" id="params-empty">Loading parameters…</div>
    </div>
    <div class="pane" id="pane-documents">
      <table class="t"><thead><tr><th>Name</th><th>Type</th><th>Format</th><th>Owner</th><th>Platforms</th><th>Action</th></tr></thead>
      <tbody id="docs-body"></tbody></table>
      <div class="empty" id="docs-empty">Click Refresh to list documents.</div>
    </div>
    <div class="pane" id="pane-executions">
      <table class="t"><thead><tr><th>Kind</th><th>Status</th><th>Document</th><th>Started</th><th>Detail</th><th>ID</th></tr></thead>
      <tbody id="execs-body"></tbody></table>
      <div class="empty" id="execs-empty">Click Refresh to load recent executions.</div>
    </div>
  </div>

  <!-- Trigger modal -->
  <div class="overlay" id="trigger-overlay">
    <div class="modal">
      <h3 id="trigger-title">Run document</h3>
      <div class="sub" id="trigger-sub"></div>
      <div class="field-instances" id="field-instances">
        <label>Target instance IDs (comma or space separated)</label>
        <input id="trigger-instances" placeholder="i-0abc123…, i-0def456…" />
        <div class="hint">Required for Run Command (Command documents).</div>
      </div>
      <label>Parameters (JSON object)</label>
      <textarea id="trigger-params" spellcheck="false" placeholder='{ "commands": ["echo hello"] }'></textarea>
      <div class="hint">Values may be a string or array of strings; they're sent as SSM string-list parameters.</div>
      <div class="actions">
        <button class="btn ghost" id="trigger-cancel">Cancel</button>
        <button class="btn" id="trigger-go">Run</button>
      </div>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var errorBanner = document.getElementById('error-banner');
    function showError(msg){ errorBanner.textContent = msg; errorBanner.style.display='block'; }
    function clearError(){ errorBanner.style.display='none'; }
    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function fmtTs(iso){ if(!iso) return '—'; try { return new Date(iso).toLocaleString(); } catch(_) { return String(iso); } }

    // Tabs
    var tabs = document.querySelectorAll('.tab');
    var loaded = { parameters: true, documents: false, executions: false };
    tabs.forEach(function(t){
      t.onclick = function(){
        var id = t.getAttribute('data-tab');
        tabs.forEach(function(x){ x.classList.toggle('active', x === t); });
        document.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.id === 'pane-' + id); });
        document.querySelectorAll('.tab-toolbar').forEach(function(tb){ tb.style.display = tb.getAttribute('data-for') === id ? 'flex' : 'none'; });
        if (!loaded[id]) {
          loaded[id] = true;
          if (id === 'documents') vscode.postMessage({ type:'loadDocuments', owner: document.getElementById('docs-owner').value });
          else if (id === 'executions') vscode.postMessage({ type:'loadExecutions' });
        }
      };
    });

    // Parameters
    document.getElementById('params-refresh').onclick = function(){ clearError(); vscode.postMessage({ type:'loadParameters' }); };
    function renderParameters(m){
      var tb = document.getElementById('params-body');
      var empty = document.getElementById('params-empty');
      document.getElementById('params-trunc').style.display = m.truncated ? '' : 'none';
      document.getElementById('params-count').textContent = (m.rows ? m.rows.length : 0) + ' parameters';
      if (!m.rows || !m.rows.length){ tb.innerHTML=''; empty.style.display='block'; empty.textContent='No parameters found.'; return; }
      empty.style.display='none';
      tb.innerHTML = m.rows.map(function(r){
        return '<tr>' +
          '<td class="mono">' + esc(r.name) + '</td>' +
          '<td>' + esc(r.ptype) + '</td>' +
          '<td>' + esc(r.tier) + '</td>' +
          '<td>' + esc(r.version==null?'':r.version) + '</td>' +
          '<td class="mono muted">' + esc(fmtTs(r.lastModified)) + '</td>' +
          '<td class="val-cell" data-val-for="' + esc(r.name) + '"><button class="row-btn" data-get-param="' + esc(r.name) + '">\u{1F441} view</button></td>' +
        '</tr>';
      }).join('');
      tb.querySelectorAll('[data-get-param]').forEach(function(b){
        b.onclick = function(){ b.textContent='…'; vscode.postMessage({ type:'getParameter', name:b.getAttribute('data-get-param') }); };
      });
    }
    function renderParameterValue(m){
      var cell = document.querySelector('[data-val-for="' + (window.CSS && CSS.escape ? CSS.escape(m.name) : m.name) + '"]');
      if (!cell) return;
      cell.textContent = m.value;
    }

    // Documents
    document.getElementById('docs-refresh').onclick = function(){ clearError(); vscode.postMessage({ type:'loadDocuments', owner: document.getElementById('docs-owner').value }); };
    document.getElementById('docs-owner').onchange = function(){ vscode.postMessage({ type:'loadDocuments', owner: this.value }); };
    function renderDocuments(m){
      var tb = document.getElementById('docs-body');
      var empty = document.getElementById('docs-empty');
      document.getElementById('docs-trunc').style.display = m.truncated ? '' : 'none';
      document.getElementById('docs-count').textContent = (m.rows ? m.rows.length : 0) + ' documents';
      if (!m.rows || !m.rows.length){ tb.innerHTML=''; empty.style.display='block'; empty.textContent='No documents found for owner "' + esc(m.owner) + '".'; return; }
      empty.style.display='none';
      tb.innerHTML = m.rows.map(function(r){
        var canRun = r.docType === 'Command' || r.docType === 'Automation';
        var btn = canRun ? '<button class="row-btn" data-run-doc="' + esc(r.name) + '" data-run-type="' + esc(r.docType) + '">▶ Run</button>' : '<span class="muted">—</span>';
        return '<tr>' +
          '<td class="mono">' + esc(r.name) + '</td>' +
          '<td>' + esc(r.docType) + '</td>' +
          '<td>' + esc(r.format) + '</td>' +
          '<td>' + esc(r.owner) + '</td>' +
          '<td class="muted">' + esc(r.platforms) + '</td>' +
          '<td>' + btn + '</td>' +
        '</tr>';
      }).join('');
      tb.querySelectorAll('[data-run-doc]').forEach(function(b){
        b.onclick = function(){ openTrigger(b.getAttribute('data-run-doc'), b.getAttribute('data-run-type')); };
      });
    }

    // Trigger modal
    var overlay = document.getElementById('trigger-overlay');
    var trigName = '', trigType = '';
    function openTrigger(name, docType){
      trigName = name; trigType = docType;
      document.getElementById('trigger-title').textContent = (docType === 'Automation' ? 'Start automation: ' : 'Run command: ') + name;
      document.getElementById('trigger-sub').textContent = docType === 'Automation'
        ? 'StartAutomationExecution — provide parameters the document expects.'
        : 'SendCommand — provide target instance ids and parameters.';
      document.getElementById('field-instances').style.display = docType === 'Command' ? 'block' : 'none';
      document.getElementById('trigger-instances').value = '';
      document.getElementById('trigger-params').value = '';
      overlay.classList.add('show');
    }
    document.getElementById('trigger-cancel').onclick = function(){ overlay.classList.remove('show'); };
    document.getElementById('trigger-go').onclick = function(){
      overlay.classList.remove('show');
      vscode.postMessage({
        type:'triggerDocument', name: trigName, docType: trigType,
        parameters: document.getElementById('trigger-params').value,
        instanceIds: document.getElementById('trigger-instances').value,
      });
    };

    // Executions
    document.getElementById('execs-refresh').onclick = function(){ clearError(); vscode.postMessage({ type:'loadExecutions' }); };
    function renderExecutions(m){
      var tb = document.getElementById('execs-body');
      var empty = document.getElementById('execs-empty');
      document.getElementById('execs-count').textContent = (m.rows ? m.rows.length : 0) + ' recent';
      if (!m.rows || !m.rows.length){ tb.innerHTML=''; empty.style.display='block'; empty.textContent='No recent executions.'; return; }
      empty.style.display='none';
      tb.innerHTML = m.rows.map(function(r){
        return '<tr>' +
          '<td>' + esc(r.kind) + '</td>' +
          '<td><span class="pill st-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
          '<td class="mono">' + esc(r.document) + '</td>' +
          '<td class="mono muted">' + esc(fmtTs(r.started)) + '</td>' +
          '<td class="muted">' + esc(r.detail) + '</td>' +
          '<td class="mono muted">' + esc(r.id) + '</td>' +
        '</tr>';
      }).join('');
    }

    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (m.type === 'scope') {
        document.getElementById('hdr-profile').textContent = m.profileName;
        document.getElementById('hdr-account').textContent = m.accountId;
        document.getElementById('hdr-region').textContent = m.region;
      } else if (m.type === 'parameters') { renderParameters(m); }
      else if (m.type === 'parameterValue') { renderParameterValue(m); }
      else if (m.type === 'documents') { renderDocuments(m); }
      else if (m.type === 'executions') { renderExecutions(m); }
      else if (m.type === 'triggered') { /* toast shown natively */ }
      else if (m.type === 'error') { showError(m.message || 'Unknown error'); }
    });

    vscode.postMessage({ type:'ready' });
  </script>
</body>
</html>`;
  }
}
