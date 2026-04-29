import * as vscode from "vscode";
import { InvokeCommand, LogType, type InvocationResponse } from "@aws-sdk/client-lambda";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

export class LambdaInvokePanel {
  private static panels = new Map<string, LambdaInvokePanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly functionName: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.functionName = (resource.rawJson.FunctionName as string) ?? resource.name ?? resource.id;

    // Open in the active column so the invoke UI takes over the current tab
    // (the service detail panel) rather than splitting alongside it.
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewLambdaInvoke",
      `Invoke: ${this.functionName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => LambdaInvokePanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "invoke") {
        await this.invokeLambda(msg.payload, msg.invocationType ?? "RequestResponse");
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = LambdaInvokePanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const instance = new LambdaInvokePanel(platform, resource);
    LambdaInvokePanel.panels.set(resource.arn, instance);
  }

  private async invokeLambda(payloadStr: string, invocationType: string): Promise<void> {
    const startMs = Date.now();

    try {
      let parsedPayload: Uint8Array | undefined;
      const trimmed = payloadStr.trim();
      if (trimmed.length > 0) {
        JSON.parse(trimmed);
        parsedPayload = new TextEncoder().encode(trimmed);
      }

      const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
      if (!profileName) {
        this.postResult({ error: "No AWS profile found for this account." });
        return;
      }

      const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
      const client = await this.platform.awsClientFactory.lambda(scope);

      const response: InvocationResponse = await client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: invocationType as "RequestResponse" | "Event" | "DryRun",
          LogType: invocationType === "RequestResponse" ? LogType.Tail : LogType.None,
          Payload: parsedPayload,
        }),
      );

      const elapsedMs = Date.now() - startMs;

      let responsePayload = "";
      if (response.Payload) {
        responsePayload = new TextDecoder().decode(response.Payload);
        try {
          responsePayload = JSON.stringify(JSON.parse(responsePayload), null, 2);
        } catch { /* keep raw string */ }
      }

      let logs = "";
      if (response.LogResult) {
        logs = Buffer.from(response.LogResult, "base64").toString("utf-8");
      }

      this.postResult({
        statusCode: response.StatusCode,
        functionError: response.FunctionError,
        payload: responsePayload,
        logs,
        elapsedMs,
        executedVersion: response.ExecutedVersion,
      });
    } catch (err: unknown) {
      const elapsedMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      this.postResult({ error: message, elapsedMs });
    }
  }

  private postResult(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage({ type: "invokeResult", ...data });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const fnName = escapeHtml(this.functionName);
    const runtime = escapeHtml(String(this.resource.rawJson.Runtime ?? "—"));
    const region = escapeHtml(this.resource.region);
    const memoryMb = this.resource.rawJson.MemorySize ?? "—";
    const timeoutSec = this.resource.rawJson.Timeout ?? "—";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Invoke: ${fnName}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .invoke-header {
      background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 16px 20px; flex-shrink: 0;
    }
    .invoke-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .invoke-title .fn-icon { color: var(--accent); font-size: 20px; }
    .invoke-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--muted); }
    .invoke-meta span { display: flex; align-items: center; gap: 4px; }
    .invoke-meta .label { font-weight: 600; }

    .invoke-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .invoke-section { padding: 12px 20px; }
    .invoke-section-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
      color: var(--muted); margin-bottom: 8px;
    }

    .invoke-controls { display: flex; gap: 8px; align-items: center; padding: 0 20px 12px; flex-shrink: 0; }
    .invoke-type-select {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 6px 10px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .invoke-btn {
      background: var(--accent); color: white; border: none;
      padding: 7px 20px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all .15s;
    }
    .invoke-btn:hover { background: #e68a00; }
    .invoke-btn:disabled { opacity: .5; cursor: not-allowed; }
    .invoke-btn .spinner { display: none; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }
    .invoke-btn.loading .spinner { display: inline-block; }
    .invoke-btn.loading .btn-text { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .payload-wrap { flex: 0 0 auto; max-height: 40vh; display: flex; flex-direction: column; }
    .payload-editor {
      width: 100%; min-height: 120px; max-height: 35vh;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.5;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 10px 14px; border-radius: var(--radius); resize: vertical;
      tab-size: 2;
    }
    .payload-editor:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px #FF990022; }

    .response-wrap { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
    .response-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 20px; flex-shrink: 0; }
    .response-tab {
      padding: 8px 14px; cursor: pointer; font-size: 12px; font-weight: 500;
      color: var(--muted); border-bottom: 2px solid transparent; transition: color .12s;
    }
    .response-tab:hover { color: var(--text); }
    .response-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .response-content { flex: 1; overflow: auto; padding: 12px 20px; }
    .response-pane { display: none; }
    .response-pane.active { display: block; }

    .response-output {
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.5;
      white-space: pre-wrap; word-break: break-all; color: var(--text);
      background: var(--surface-2); border: 1px solid var(--border);
      padding: 12px 14px; border-radius: var(--radius);
      min-height: 60px; max-height: none;
    }
    .response-output.error-output { border-color: #fecaca; background: #fef2f2; color: #b91c1c; }

    .result-meta { display: flex; gap: 16px; margin-bottom: 12px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .result-meta .badge { font-size: 11px; }

    .empty-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--light); padding: 40px; text-align: center; height: 100%;
    }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }
    .empty-state .hint { font-size: 12px; max-width: 300px; }

    .log-output {
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-all; color: var(--text);
      background: #1a202c; color: #e2e8f0; border-radius: var(--radius);
      padding: 12px 14px; min-height: 60px;
    }
    .log-output .log-error { color: #f48771; }
    .log-output .log-report { color: #c586c0; }
    .log-output .log-start { color: #9cdcfe; }
    .log-output .log-init { color: #4fc1ff; }
  </style>
</head>
<body>
  <div class="invoke-header">
    <div class="invoke-title">
      <span class="fn-icon">\u03BB</span>
      <span>${fnName}</span>
    </div>
    <div class="invoke-meta">
      <span><span class="label">Runtime:</span> ${runtime}</span>
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Memory:</span> ${String(memoryMb)} MB</span>
      <span><span class="label">Timeout:</span> ${String(timeoutSec)}s</span>
    </div>
  </div>

  <div class="invoke-body">
    <div class="payload-wrap">
      <div class="invoke-section">
        <div class="invoke-section-title">Request Payload (JSON)</div>
        <textarea class="payload-editor" id="payload" spellcheck="false" placeholder='{\n  "key": "value"\n}'>{}</textarea>
      </div>
      <div class="invoke-controls">
        <select class="invoke-type-select" id="invocationType" title="Invocation type">
          <option value="RequestResponse">Synchronous (RequestResponse)</option>
          <option value="Event">Asynchronous (Event)</option>
          <option value="DryRun">Dry Run (validate only)</option>
        </select>
        <button class="invoke-btn" id="invokeBtn">
          <span class="spinner"></span>
          <span class="btn-text">\u25B6 Invoke</span>
        </button>
      </div>
    </div>

    <div class="response-wrap">
      <div class="response-tabs">
        <div class="response-tab active" data-tab="response">Response</div>
        <div class="response-tab" data-tab="logs">Execution Logs</div>
      </div>
      <div class="response-content">
        <div class="response-pane active" id="pane-response">
          <div class="empty-state" id="response-empty">
            <div class="icon">\u{1F680}</div>
            <div class="hint">Click <strong>Invoke</strong> to execute the Lambda function and see the response here.</div>
          </div>
          <div id="response-result" style="display:none;">
            <div class="result-meta" id="result-meta"></div>
            <div class="response-output" id="response-payload"></div>
          </div>
        </div>
        <div class="response-pane" id="pane-logs">
          <div class="empty-state" id="logs-empty">
            <div class="icon">\u{1F4CB}</div>
            <div class="hint">Execution logs will appear here after invoking the function synchronously.</div>
          </div>
          <div class="log-output" id="logs-output" style="display:none;"></div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var invokeBtn = document.getElementById('invokeBtn');
    var payloadEl = document.getElementById('payload');
    var typeEl = document.getElementById('invocationType');

    invokeBtn.onclick = function() {
      var payload = payloadEl.value;
      var invocationType = typeEl.value;

      invokeBtn.classList.add('loading');
      invokeBtn.disabled = true;

      vscode.postMessage({ type: 'invoke', payload: payload, invocationType: invocationType });
    };

    payloadEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = this.selectionStart;
        var end = this.selectionEnd;
        this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        invokeBtn.click();
      }
    });

    document.querySelectorAll('.response-tab').forEach(function(tab) {
      tab.onclick = function() {
        document.querySelectorAll('.response-tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.response-pane').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
      };
    });

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function colorizeLogs(text) {
      return text.split('\\n').map(function(line) {
        if (/^START /.test(line)) return '<span class="log-start">' + esc(line) + '</span>';
        if (/^END /.test(line)) return '<span class="log-start">' + esc(line) + '</span>';
        if (/^REPORT /.test(line)) return '<span class="log-report">' + esc(line) + '</span>';
        if (/^INIT_START/.test(line)) return '<span class="log-init">' + esc(line) + '</span>';
        if (/error|exception|traceback/i.test(line)) return '<span class="log-error">' + esc(line) + '</span>';
        return esc(line);
      }).join('\\n');
    }

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'invokeResult') {
        invokeBtn.classList.remove('loading');
        invokeBtn.disabled = false;

        if (msg.error) {
          document.getElementById('response-empty').style.display = 'none';
          var resultEl = document.getElementById('response-result');
          resultEl.style.display = 'block';

          document.getElementById('result-meta').innerHTML =
            '<span class="badge badge-red">Error</span>' +
            (msg.elapsedMs ? '<span>' + msg.elapsedMs + ' ms</span>' : '');

          var payloadEl = document.getElementById('response-payload');
          payloadEl.className = 'response-output error-output';
          payloadEl.textContent = msg.error;
        } else {
          document.getElementById('response-empty').style.display = 'none';
          var resultEl = document.getElementById('response-result');
          resultEl.style.display = 'block';

          var metaHtml = '';
          if (msg.statusCode !== undefined) {
            var isOk = msg.statusCode >= 200 && msg.statusCode < 300 && !msg.functionError;
            metaHtml += '<span class="badge ' + (isOk ? 'badge-green' : 'badge-red') + '">Status ' + msg.statusCode + '</span>';
          }
          if (msg.functionError) {
            metaHtml += '<span class="badge badge-red">' + esc(msg.functionError) + '</span>';
          }
          if (msg.elapsedMs !== undefined) {
            metaHtml += '<span>' + msg.elapsedMs + ' ms</span>';
          }
          if (msg.executedVersion) {
            metaHtml += '<span>Version: ' + esc(msg.executedVersion) + '</span>';
          }
          document.getElementById('result-meta').innerHTML = metaHtml;

          var payloadEl = document.getElementById('response-payload');
          payloadEl.className = 'response-output' + (msg.functionError ? ' error-output' : '');
          payloadEl.textContent = msg.payload || '(empty response)';

          if (msg.logs) {
            document.getElementById('logs-empty').style.display = 'none';
            var logsEl = document.getElementById('logs-output');
            logsEl.style.display = 'block';
            logsEl.innerHTML = colorizeLogs(msg.logs);
          }
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
