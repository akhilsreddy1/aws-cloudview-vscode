import * as vscode from "vscode";
import { GetTemplateCommand, type TemplateStage } from "@aws-sdk/client-cloudformation";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Webview that fetches and displays a CloudFormation stack's template via
 * `GetTemplate`. Supports the two server-side stages (`Original` and
 * `Processed`) and pretty-prints JSON; YAML is left as-is since YAML round-trip
 * with the CloudFormation custom tags (`!Ref`, `!GetAtt`, etc.) requires a
 * tag-aware parser we don't ship.
 *
 * Read-only. The panel never calls any mutating CloudFormation API.
 */
export class CfnTemplatePanel {
  private static panels = new Map<string, CfnTemplatePanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly stackName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.stackName = resource.name || resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewCfnTemplate",
      `Template: ${this.stackName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => CfnTemplatePanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "loadTemplate") {
          const stage = msg.stage === "Processed" ? "Processed" : "Original";
          await this.loadTemplate(stage);
        } else if (msg.type === "openInEditor") {
          await this.openInEditor(String(msg.body ?? ""), String(msg.format ?? "json"));
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
    // Auto-load on open so the user sees the template without an extra click.
    void this.loadTemplate("Original");
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = CfnTemplatePanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new CfnTemplatePanel(platform, resource);
    CfnTemplatePanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadTemplate(stage: "Original" | "Processed"): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    const client = await this.platform.awsClientFactory.cloudformation(scope);
    const resp = await this.platform.scheduler.run("cloudformation", "GetTemplate", () =>
      client.send(new GetTemplateCommand({
        StackName: this.stackName,
        TemplateStage: stage as TemplateStage,
      }))
    );

    const body = resp.TemplateBody ?? "";
    const stagesAvailable = resp.StagesAvailable ?? [];
    const detected = detectFormat(body);
    const formatted = detected === "json" ? prettyJson(body) : body;

    void this.panel.webview.postMessage({
      type: "templateResult",
      stage,
      stagesAvailable,
      body: formatted,
      format: detected,
      sizeBytes: Buffer.byteLength(formatted, "utf8"),
    });
  }

  /**
   * Open the template in a new untitled VS Code editor so the user can use
   * regular editor features (find, fold, save). We pick the language based on
   * detected format so syntax highlighting kicks in.
   */
  private async openInEditor(body: string, format: string): Promise<void> {
    const language = format === "yaml" ? "yaml" : "json";
    const doc = await vscode.workspace.openTextDocument({ content: body, language });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.stackName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const accountId = escapeHtml(this.resource.accountId);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Template: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .cfn-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 20px; flex-shrink: 0; }
    .cfn-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .cfn-title .t-icon { color: #1d4ed8; font-size: 20px; }
    .cfn-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .cfn-meta span { display: flex; align-items: center; gap: 4px; }
    .cfn-meta .label { font-weight: 600; }
    .arn-row { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; word-break: break-all; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar select {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .btn {
      background: var(--accent); color: white; border: none;
      padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }

    .summary-row { padding: 8px 20px; font-size: 11px; color: var(--muted); background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; gap: 16px; flex-wrap: wrap; }
    .summary-row strong { color: var(--text-2); font-weight: 600; }
    .badge-fmt { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
    .badge-fmt.json { background: #dbeafe; color: #1e40af; }
    .badge-fmt.yaml { background: #fef3c7; color: #92400e; }

    .content { flex: 1; overflow: auto; background: var(--surface); padding: 0; position: relative; }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }
    .template-body {
      padding: 16px 20px; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px; line-height: 1.55; white-space: pre; color: var(--text);
      tab-size: 2;
    }

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
      <span class="t-icon">\u{1F4DC}</span>
      <span>${name}</span>
    </div>
    <div class="cfn-meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Account:</span> ${accountId}</span>
      <span><span class="label">Stack:</span> ${name}</span>
    </div>
    <div class="arn-row">${arn}</div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <label>Stage</label>
    <select id="stage-sel">
      <option value="Original" selected>Original</option>
      <option value="Processed">Processed (after transforms)</option>
    </select>
    <button class="btn ghost" id="reload-btn">↻ Reload</button>
    <span style="flex:1;"></span>
    <button class="btn ghost" id="copy-btn">\u{1F4CB} Copy</button>
    <button class="btn ghost" id="open-btn">\u{1F4DD} Open in editor</button>
  </div>

  <div class="summary-row" id="summary" style="display:none;"></div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F4DC}</div>
      <div>Loading template…</div>
    </div>
    <pre class="template-body" id="body" style="display:none;"></pre>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var stageSel = document.getElementById('stage-sel');
    var reloadBtn = document.getElementById('reload-btn');
    var copyBtn = document.getElementById('copy-btn');
    var openBtn = document.getElementById('open-btn');
    var errorBanner = document.getElementById('error-banner');
    var summary = document.getElementById('summary');
    var bodyEl = document.getElementById('body');
    var emptyEl = document.getElementById('empty');
    var current = { body: '', format: 'json' };

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      setTimeout(function(){ errorBanner.style.display = 'none'; }, 8000);
    }
    function fmtBytes(n) {
      if (!isFinite(n) || n <= 0) return '0 B';
      var u = ['B','KB','MB']; var i = Math.floor(Math.log(n) / Math.log(1024));
      return (n / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
    }

    function loadStage() {
      reloadBtn.disabled = true;
      emptyEl.style.display = 'flex';
      emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading template…';
      bodyEl.style.display = 'none';
      summary.style.display = 'none';
      vscode.postMessage({ type: 'loadTemplate', stage: stageSel.value });
    }

    reloadBtn.onclick = loadStage;
    stageSel.onchange = loadStage;

    copyBtn.onclick = function() {
      if (!current.body) return;
      navigator.clipboard.writeText(current.body).catch(function() {
        var t = document.createElement('textarea');
        t.value = current.body; document.body.appendChild(t); t.select();
        document.execCommand('copy'); document.body.removeChild(t);
      });
      copyBtn.textContent = '✓ Copied';
      setTimeout(function(){ copyBtn.textContent = '\u{1F4CB} Copy'; }, 1500);
    };

    openBtn.onclick = function() {
      if (!current.body) return;
      vscode.postMessage({ type: 'openInEditor', body: current.body, format: current.format });
    };

    window.addEventListener('message', function(ev) {
      var m = ev.data;
      reloadBtn.disabled = false;
      if (m.type === 'templateResult') {
        current.body = m.body || '';
        current.format = m.format || 'json';
        if (!current.body) {
          emptyEl.style.display = 'flex';
          emptyEl.querySelector('div:nth-child(2)').textContent = 'Empty template body returned by AWS.';
          bodyEl.style.display = 'none';
          summary.style.display = 'none';
          return;
        }
        emptyEl.style.display = 'none';
        bodyEl.style.display = 'block';
        bodyEl.textContent = current.body;
        var bits = [];
        bits.push('format: <span class="badge-fmt ' + esc(current.format) + '">' + esc(current.format) + '</span>');
        bits.push('stage: <strong>' + esc(m.stage) + '</strong>');
        bits.push('size: <strong>' + fmtBytes(m.sizeBytes) + '</strong>');
        if (m.stagesAvailable && m.stagesAvailable.length) {
          bits.push('stages available: <strong>' + m.stagesAvailable.join(', ') + '</strong>');
        }
        summary.innerHTML = bits.join(' · ');
        summary.style.display = 'flex';
      } else if (m.type === 'error') {
        showError(m.message || 'Unknown error');
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Failed to load template. See error above.';
      }
    });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * CloudFormation `GetTemplate` returns the body in whatever format was
 * uploaded. We sniff JSON-vs-YAML by checking if the first non-whitespace
 * character is `{` (JSON object) — every CloudFormation template is an object,
 * so this is reliable in practice.
 */
function detectFormat(body: string): "json" | "yaml" {
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") ? "json" : "yaml";
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not valid JSON despite the leading brace — return raw rather than throw.
    return body;
  }
}
