import * as vscode from "vscode";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Secrets Manager secret panel: view the current value (masked by default,
 * with an explicit reveal) and save a new version of the value via
 * `PutSecretValue`. Values are fetched on demand — never during discovery —
 * and are never persisted to the local cache.
 *
 * Only the secret **value** is editable here. Description, tags, and rotation
 * are read-only (managed in the console) to keep the surface area small.
 */
export class SecretValuePanel {
  private static panels = new Map<string, SecretValuePanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly secretName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.secretName = (resource.rawJson.SecretName as string) ?? resource.name ?? resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewSecretValue",
      `Secret: ${this.secretName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => SecretValuePanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "reveal") {
          await this.loadValue();
        } else if (msg.type === "save" && typeof msg.value === "string") {
          await this.saveValue(msg.value);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = SecretValuePanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new SecretValuePanel(platform, resource);
    SecretValuePanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadValue(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.secretsManager(scope);
    try {
      const resp = await this.platform.scheduler.run("secretsmanager", "GetSecretValue", () =>
        client.send(new GetSecretValueCommand({ SecretId: this.resource.arn }))
      );
      const isBinary = resp.SecretString == null && resp.SecretBinary != null;
      const value = resp.SecretString
        ?? (resp.SecretBinary ? Buffer.from(resp.SecretBinary).toString("base64") : "");
      void this.panel.webview.postMessage({
        type: "value",
        value,
        isBinary,
        versionId: resp.VersionId,
        createdDate: resp.CreatedDate ? resp.CreatedDate.toISOString() : undefined,
      });
    } catch (err: unknown) {
      this.postError(`GetSecretValue failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async saveValue(value: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Save a new version of secret "${this.secretName}"?`,
      {
        modal: true,
        detail: `Region: ${this.resource.region}\nAccount: ${this.resource.accountId}\n\nThis creates a new secret version (PutSecretValue) and marks it AWSCURRENT. Applications reading this secret will pick up the new value. The previous version is retained as AWSPREVIOUS.`,
      },
      "Save new version",
    );
    if (confirm !== "Save new version") return;

    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.secretsManager(scope);
    try {
      const resp = await this.platform.scheduler.run("secretsmanager", "PutSecretValue", () =>
        client.send(new PutSecretValueCommand({ SecretId: this.resource.arn, SecretString: value }))
      );
      void vscode.window.showInformationMessage(
        `Saved new version of "${this.secretName}" (${resp.VersionId?.slice(0, 8) ?? "new"}…).`,
      );
      void this.panel.webview.postMessage({ type: "saved", versionId: resp.VersionId });
    } catch (err: unknown) {
      this.postError(`PutSecretValue failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.secretName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const description = escapeHtml((this.resource.rawJson.Description as string) ?? "");
    const rotation = this.resource.rawJson.RotationEnabled === true;
    const owning = escapeHtml((this.resource.rawJson.OwningService as string) ?? "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Secret: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #DD3344; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; background: #e0e7ff; color: #3730a3; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .btn { background: var(--accent); color: #fff; border: none; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }
    .version-note { margin-left: auto; font-size: 11px; color: var(--muted); }

    .content { flex: 1; overflow: auto; padding: 16px 20px; }
    .masked-box { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 50px; text-align: center; border: 1px dashed var(--border-2); border-radius: var(--radius); }
    .masked-box .icon { font-size: 30px; margin-bottom: 10px; }
    .editor-label { font-size: 11px; color: var(--muted); font-weight: 600; margin-bottom: 6px; display: flex; gap: 10px; align-items: center; }
    textarea#val {
      width: 100%; min-height: 280px; resize: vertical;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 10px 12px; border-radius: var(--radius); font-size: 13px;
      font-family: 'SF Mono','Fira Code',Menlo,monospace; line-height: 1.5; tab-size: 2;
    }
    .binary-warn { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; padding: 8px 12px; border-radius: var(--radius); font-size: 12px; margin-bottom: 10px; display: none; }
    .json-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #dcfce7; color: #166534; font-weight: 700; display: none; }
    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F510}</span>
      <span>${name}</span>
      ${rotation ? '<span class="pill">rotation on</span>' : ""}
      ${owning ? `<span class="pill" style="background:#e5e7eb;color:#374151;">${owning}</span>` : ""}
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      ${description ? `<span><span class="label">Description:</span> ${description}</span>` : ""}
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <button class="btn" id="reveal-btn">\u{1F441} Reveal value</button>
    <button class="btn" id="save-btn" style="display:none;">\u{1F4BE} Save new version</button>
    <button class="btn ghost" id="format-btn" style="display:none;">{ } Format JSON</button>
    <span class="json-badge" id="json-badge">valid JSON</span>
    <span class="version-note" id="version-note"></span>
  </div>

  <div class="content">
    <div class="masked-box" id="masked">
      <div class="icon">\u{1F512}</div>
      <div>This secret's value is hidden.</div>
      <div style="font-size:11px;margin-top:6px;">Click <strong>Reveal value</strong> to fetch it (GetSecretValue). Nothing is cached.</div>
    </div>
    <div id="editor" style="display:none;">
      <div class="binary-warn" id="binary-warn">This secret is binary; shown base64-encoded. Saving will store your text as a new SecretString.</div>
      <div class="editor-label">Secret value <span id="json-hint"></span></div>
      <textarea id="val" spellcheck="false"></textarea>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var revealBtn = document.getElementById('reveal-btn');
    var saveBtn = document.getElementById('save-btn');
    var formatBtn = document.getElementById('format-btn');
    var jsonBadge = document.getElementById('json-badge');
    var versionNote = document.getElementById('version-note');
    var maskedEl = document.getElementById('masked');
    var editorEl = document.getElementById('editor');
    var binaryWarn = document.getElementById('binary-warn');
    var valEl = document.getElementById('val');
    var errorBanner = document.getElementById('error-banner');

    function showError(msg){ errorBanner.textContent = msg; errorBanner.style.display='block'; }
    function clearError(){ errorBanner.style.display='none'; }

    function refreshJsonState(){
      var t = valEl.value.trim();
      if (!t) { jsonBadge.style.display='none'; return; }
      try { JSON.parse(t); jsonBadge.style.display='inline-block'; }
      catch(_) { jsonBadge.style.display='none'; }
    }

    revealBtn.onclick = function(){
      clearError();
      revealBtn.disabled = true; revealBtn.textContent = 'Fetching…';
      vscode.postMessage({ type: 'reveal' });
    };
    saveBtn.onclick = function(){
      clearError();
      vscode.postMessage({ type: 'save', value: valEl.value });
    };
    formatBtn.onclick = function(){
      try { valEl.value = JSON.stringify(JSON.parse(valEl.value), null, 2); refreshJsonState(); }
      catch(e){ showError('Not valid JSON: ' + e.message); }
    };
    valEl.addEventListener('input', refreshJsonState);

    window.addEventListener('message', function(ev){
      var m = ev.data;
      if (m.type === 'value') {
        revealBtn.disabled = false; revealBtn.textContent = '\u{1F441} Reveal value';
        revealBtn.style.display = 'none';
        maskedEl.style.display = 'none';
        editorEl.style.display = 'block';
        saveBtn.style.display = '';
        formatBtn.style.display = '';
        binaryWarn.style.display = m.isBinary ? 'block' : 'none';
        valEl.value = m.value || '';
        if (m.versionId) versionNote.textContent = 'current version: ' + m.versionId.slice(0,8) + '…';
        refreshJsonState();
      } else if (m.type === 'saved') {
        if (m.versionId) versionNote.textContent = 'current version: ' + m.versionId.slice(0,8) + '… (saved)';
      } else if (m.type === 'error') {
        revealBtn.disabled = false; revealBtn.textContent = '\u{1F441} Reveal value';
        showError(m.message || 'Unknown error');
      }
    });
  </script>
</body>
</html>`;
  }
}
