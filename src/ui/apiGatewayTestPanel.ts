import * as vscode from "vscode";
import { TestInvokeMethodCommand } from "@aws-sdk/client-api-gateway";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * **Test panel** for a single API Gateway REST route.
 *
 * Wraps the SDK's `TestInvokeMethod` — the same call the AWS Console's
 * "TEST" tab uses. It runs the request through the full API-Gateway request
 * pipeline (integration mapping, VTL templates, integration invocation) but
 * **bypasses the stage**: no deployment required, no throttling / usage-plan
 * check, IAM auth uses the local profile's credentials.
 *
 * The response includes the CloudWatch execution log so users can see the
 * exact request the integration received — invaluable for debugging why a
 * Kinesis/Lambda/whatever integration didn't do what they expected.
 *
 * Not applicable to v2 (HTTP/WebSocket) APIs — those have no server-side
 * TestInvoke; the caller keeps the button hidden for those rows.
 */
export class ApiGatewayTestPanel {
  private static panels = new Map<string, ApiGatewayTestPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly apiId: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
    private readonly restRoute: RestRouteRef,
  ) {
    this.apiId = resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewApiGatewayTest",
      `Test: ${restRoute.method} ${restRoute.path}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => ApiGatewayTestPanel.panels.delete(panelKey(resource.arn, restRoute)));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "test" && msg.payload) {
          await this.runTest(msg.payload as TestPayload);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(
    platform: CloudViewPlatform,
    resource: ResourceNode,
    route: RestRouteRef,
  ): Promise<void> {
    const key = panelKey(resource.arn, route);
    const existing = ApiGatewayTestPanel.panels.get(key);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new ApiGatewayTestPanel(platform, resource, route);
    ApiGatewayTestPanel.panels.set(key, instance);
  }

  private async runTest(payload: TestPayload): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return;
    }
    const client = await this.platform.awsClientFactory.apiGateway({
      profileName, accountId: this.resource.accountId, region: this.resource.region,
    });

    // TestInvokeMethod wants the FULL substituted path + query string —
    // whatever the user typed in the URL bar. We forward it as-is; if any
    // `{token}` placeholders remain (user forgot to fill one in), AWS will
    // surface that in the response body and we'll show it verbatim.
    const pathWithQuery = payload.pathWithQuery;
    const start = Date.now();
    try {
      const resp = await this.platform.scheduler.run("apigateway", "TestInvokeMethod", () =>
        client.send(new TestInvokeMethodCommand({
          restApiId: this.apiId,
          resourceId: this.restRoute.resourceId,
          httpMethod: this.restRoute.method,
          pathWithQueryString: pathWithQuery,
          body: payload.body || undefined,
          headers: payload.headers,
          stageVariables: Object.keys(payload.stageVariables).length > 0 ? payload.stageVariables : undefined,
        })),
      );
      const roundTripMs = Date.now() - start;
      void this.panel.webview.postMessage({
        type: "response",
        status: resp.status,
        headers: resp.headers ?? {},
        body: resp.body ?? "",
        log: resp.log ?? "",
        latencyMs: resp.latency,
        roundTripMs,
        pathWithQuery,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`TestInvokeMethod failed: ${message}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const apiName = escapeHtml(this.resource.name || this.apiId);
    const region = escapeHtml(this.resource.region);
    const method = escapeHtml(this.restRoute.method);

    // Prefill URL bar. Start with the template path, then append any declared
    // query-string parameters as `?name=&name2=` so the user can jump straight
    // to filling values instead of remembering key names.
    const declaredQuery = this.restRoute.requestParams?.querystring ?? [];
    const qsSuffix = declaredQuery.length > 0
      ? "?" + declaredQuery.map((q) => `${q.name}=`).join("&")
      : "";
    const initialUrlJson = JSON.stringify(this.restRoute.path + qsSuffix);

    // Preseed the Headers editor with declared headers (Content-Type default
    // last, so it stays visible even when the method declares no headers).
    // Required headers get a red-star hint in the placeholder.
    const declaredHeaders = this.restRoute.requestParams?.header ?? [];
    const preseedHeaders: Array<[string, string, boolean]> = declaredHeaders
      .map<[string, string, boolean]>((h) => [h.name, "", h.required]);
    if (!declaredHeaders.some((h) => h.name.toLowerCase() === "content-type")) {
      preseedHeaders.push(["Content-Type", "application/json", false]);
    }
    const preseedHeadersJson = JSON.stringify(preseedHeaders);

    // Full requestParams contract sent to the webview so we can compute the
    // "still missing" hint in real time as the user types.
    const requestParamsJson = JSON.stringify(this.restRoute.requestParams ?? { querystring: [], header: [], path: [] });

    // Merge path parameters from two sources:
    //   1. `{tokens}` in the URL template — user needs to fill these in.
    //   2. Declared path params from method.request.path.* — AWS-side contract.
    // Usually these are the same list, but we surface the union so nothing
    // hides silently (e.g. a declared param that isn't in the path template).
    const declaredPathParams = this.restRoute.requestParams?.path ?? [];
    const tokenParams = extractPathParams(this.restRoute.path);
    const requiredByName = new Map<string, boolean>(declaredPathParams.map((p) => [p.name, p.required]));
    const pathParamsMerged: Array<{ name: string; required: boolean; inUrl: boolean }> = [];
    const seenPathParams = new Set<string>();
    for (const t of tokenParams) {
      pathParamsMerged.push({ name: t, required: requiredByName.get(t) ?? true, inUrl: true });
      seenPathParams.add(t);
    }
    for (const d of declaredPathParams) {
      if (!seenPathParams.has(d.name)) {
        // Declared but not in the URL template — show it so the user can
        // add it if it matters (AWS Console shows it too).
        pathParamsMerged.push({ name: d.name, required: d.required, inUrl: false });
      }
    }
    const pathParamsJson = JSON.stringify(pathParamsMerged);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Test ${method} ${escapeHtml(this.restRoute.path)}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; min-height: 100vh; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; }
    .title { font-size: 15px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .meta { display: flex; gap: 14px; margin-top: 4px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }

    .method-pill {
      display: inline-block; padding: 4px 12px; border-radius: 4px;
      font-family: 'SF Mono','Fira Code',monospace; font-weight: 700; font-size: 12px;
      background: #f3f4f6; color: #374151;
    }
    .method-pill.GET { background: #dcfce7; color: #166534; }
    .method-pill.POST { background: #dbeafe; color: #1e40af; }
    .method-pill.PUT { background: #fef3c7; color: #92400e; }
    .method-pill.DELETE { background: #fee2e2; color: #991b1b; }
    .method-pill.PATCH { background: #ede9fe; color: #5b21b6; }

    .body-wrap { padding: 16px 20px; max-width: 1100px; width: 100%; margin: 0 auto; }

    /* Postman-style URL bar */
    .url-bar {
      display: flex; align-items: stretch; gap: 0;
      border: 1px solid var(--border-2); border-radius: var(--radius);
      overflow: hidden; background: var(--surface); margin-bottom: 8px;
    }
    .url-bar:focus-within { border-color: rgb(99,102,241); box-shadow: 0 0 0 1px rgba(99,102,241,0.25); }
    .url-bar .method-pill {
      border-radius: 0; padding: 10px 14px; margin: 0;
      display: flex; align-items: center; border-right: 1px solid var(--border-2);
    }
    .url-bar input.url-input {
      flex: 1; border: 0; padding: 10px 12px; background: transparent; color: var(--text);
      font-family: 'SF Mono','Fira Code',monospace; font-size: 13px; min-width: 0;
    }
    .url-bar input.url-input:focus { outline: none; }
    .url-bar .send {
      background: rgb(99,102,241); color: white; border: 0; padding: 0 18px;
      font-size: 13px; font-weight: 700; cursor: pointer;
    }
    .url-bar .send:hover { background: rgb(79,70,229); }
    .url-bar .send:disabled { opacity: .5; cursor: default; }
    .url-hint {
      font-size: 11px; color: var(--muted); font-style: italic; margin-bottom: 16px;
    }
    .url-hint code { font-family: 'SF Mono','Fira Code',monospace; background: var(--surface-2); padding: 1px 5px; border-radius: 3px; color: var(--text); }
    .url-hint .missing { color: #b91c1c; font-weight: 600; font-style: normal; }

    /* Collapsible sections for headers/body/stage vars */
    details.opt { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; background: var(--surface); }
    details.opt > summary {
      cursor: pointer; padding: 8px 14px; font-size: 12px; font-weight: 700; color: var(--text);
      display: flex; align-items: center; gap: 8px; user-select: none;
    }
    details.opt > summary::marker { color: var(--muted); }
    details.opt > summary .count { font-size: 10px; padding: 1px 8px; border-radius: 10px; background: var(--surface-3); color: var(--muted); font-weight: 600; }
    details.opt > .content { padding: 10px 14px 14px; border-top: 1px solid var(--border); }

    .kv-row { display: grid; grid-template-columns: 1fr 2fr auto; gap: 6px; margin-bottom: 4px; }
    .kv-row input {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px; font-family: 'SF Mono','Fira Code',monospace;
      min-width: 0;
    }
    .kv-row input:focus { outline: 1px solid rgb(99,102,241); border-color: rgb(99,102,241); }
    .kv-remove { background: transparent; border: 1px solid var(--border-2); color: var(--muted); padding: 3px 8px; border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
    .kv-remove:hover { color: #b91c1c; border-color: #fecaca; }
    .kv-add { background: transparent; color: rgb(99,102,241); border: 1px dashed var(--border-2); padding: 5px 10px; border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; margin-top: 4px; }
    .kv-add:hover { background: rgba(99,102,241,0.06); }
    .kv-row.required input.kv-k { background: var(--surface-2); color: var(--muted); font-weight: 600; }
    .kv-row.required input.kv-v { border-color: #fed7aa; }
    .kv-row.required input.kv-v:focus { outline: 1px solid #ea580c; border-color: #ea580c; }
    .req-star { color: #dc2626; font-weight: 700; font-size: 13px; margin: 0 6px; user-select: none; }

    /* Path-parameter rows — labeled inputs that live-sync into the URL bar. */
    .pp-row { display: grid; grid-template-columns: 220px 1fr; gap: 10px; margin-bottom: 6px; align-items: center; }
    .pp-row .pp-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); }
    .pp-row .pp-label code { font-family: 'SF Mono','Fira Code',monospace; font-size: 12px; background: var(--surface-2); padding: 2px 6px; border-radius: 4px; }
    .pp-row input.pp-val {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px; font-family: 'SF Mono','Fira Code',monospace;
    }
    .pp-row input.pp-val:focus { outline: 1px solid rgb(99,102,241); border-color: rgb(99,102,241); }
    .pp-badge {
      display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .pp-badge.in-url { background: #dcfce7; color: #166534; }
    .pp-badge.missing { background: #fef3c7; color: #92400e; }

    textarea {
      width: 100%; min-height: 140px;
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 8px 10px; border-radius: var(--radius-sm); font-family: 'SF Mono','Fira Code',monospace;
      font-size: 12px; resize: vertical;
    }
    textarea:focus { outline: 1px solid rgb(99,102,241); border-color: rgb(99,102,241); }
    .body-hint { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 4px; }

    /* Response section (below the inputs) */
    .response {
      margin-top: 24px; border-top: 2px solid var(--border);
      padding-top: 18px;
    }
    .response h2 { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px; }
    .resp-empty { color: var(--light); font-style: italic; font-size: 12px; padding: 30px 0; text-align: center; border: 1px dashed var(--border-2); border-radius: var(--radius); }
    .resp-hdr { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .status-badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-weight: 700; font-size: 12px; font-family: 'SF Mono','Fira Code',monospace;
    }
    .status-badge.s2xx { background: #dcfce7; color: #166534; }
    .status-badge.s3xx { background: #dbeafe; color: #1e40af; }
    .status-badge.s4xx { background: #fef3c7; color: #92400e; }
    .status-badge.s5xx { background: #fee2e2; color: #991b1b; }
    .latency { font-size: 11px; color: var(--muted); font-family: 'SF Mono','Fira Code',monospace; }
    .resp-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
    .resp-tab {
      background: transparent; border: 0; border-bottom: 2px solid transparent;
      padding: 8px 14px; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer;
    }
    .resp-tab.active { color: var(--text); border-bottom-color: rgb(99,102,241); }
    .resp-tab:hover { color: var(--text); }
    pre.pane {
      background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: 10px 12px; font-size: 12px; font-family: 'SF Mono','Fira Code',monospace;
      white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow: auto; line-height: 1.5;
      margin: 0;
    }
    .resp-pane { display: none; }
    .resp-pane.active { display: block; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin-bottom: 12px; font-size: 12px; display: none; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span>Test route ·</span>
      <span style="color:var(--muted);font-weight:500;">${apiName}</span>
    </div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Mode:</span> TestInvokeMethod · bypasses stage + throttling</span>
    </div>
  </div>

  <div class="body-wrap">
    <div class="error-banner" id="error-banner"></div>

    <div class="url-bar">
      <span class="method-pill ${method}">${method}</span>
      <input type="text" class="url-input" id="url-input" spellcheck="false" autocomplete="off" />
      <button type="button" class="send" id="run-btn">Send</button>
    </div>
    <div class="url-hint" id="url-hint">
      Edit the URL directly — replace <code>{tokens}</code> with values, append <code>?key=value</code> for a query string.
    </div>

    <details class="opt" id="path-section" style="display:none;" open>
      <summary>Path parameters <span class="count" id="path-count">0</span></summary>
      <div class="content">
        <div id="path-params"></div>
      </div>
    </details>

    <details class="opt" open>
      <summary>Headers <span class="count" id="hdr-count">1</span></summary>
      <div class="content">
        <div id="headers"></div>
        <button type="button" class="kv-add" id="add-header">+ Add header</button>
      </div>
    </details>

    <details class="opt" ${bodyRelevant(this.restRoute.method) ? "open" : ""}>
      <summary>Body</summary>
      <div class="content">
        <textarea id="body" spellcheck="false" placeholder="Request body (JSON, form data, raw text — anything)"></textarea>
        <div class="body-hint">Sent as-is. Only meaningful for methods that accept a body (POST / PUT / PATCH / DELETE).</div>
      </div>
    </details>

    <details class="opt">
      <summary>Stage variables <span class="count" id="sv-count">0</span></summary>
      <div class="content">
        <div id="stage-vars"></div>
        <button type="button" class="kv-add" id="add-stagevar">+ Add stage variable</button>
      </div>
    </details>

    <div class="response">
      <h2>Response</h2>
      <div id="resp-empty" class="resp-empty">Send a request to see the response, execution log, and effective URL.</div>
      <div id="resp-content" style="display:none;">
        <div class="resp-hdr">
          <span class="status-badge" id="resp-status">—</span>
          <span class="latency" id="resp-latency"></span>
        </div>
        <div class="resp-tabs">
          <button type="button" class="resp-tab active" data-tab="body">Body</button>
          <button type="button" class="resp-tab" data-tab="log">Execution log</button>
          <button type="button" class="resp-tab" data-tab="headers">Headers <span id="resp-hdr-count" style="color:var(--muted);">(0)</span></button>
          <button type="button" class="resp-tab" data-tab="path">Effective URL</button>
        </div>
        <pre class="pane resp-pane active" id="resp-body-pane" data-pane="body"></pre>
        <pre class="pane resp-pane" id="resp-log-pane" data-pane="log"></pre>
        <pre class="pane resp-pane" id="resp-headers-pane" data-pane="headers"></pre>
        <pre class="pane resp-pane" id="resp-path-pane" data-pane="path"></pre>
      </div>
    </div>
  </div>

  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const INITIAL_URL = ${initialUrlJson};
    const PATH_PARAMS = ${pathParamsJson};
    const PRESEED_HEADERS = ${preseedHeadersJson};
    const REQUEST_PARAMS = ${requestParamsJson};

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg){ const el=document.getElementById('error-banner'); el.textContent=msg; el.style.display='block'; setTimeout(function(){el.style.display='none';}, 9000); }

    /* ── URL bar ─────────────────────────────────────────────────────────── */
    const urlInput = document.getElementById('url-input');
    const urlHint = document.getElementById('url-hint');
    urlInput.value = INITIAL_URL;

    /*
     * Parse the URL bar's current value into path portion + query map so we
     * can spot: (a) unresolved {token} placeholders, (b) declared required
     * query-string parameters the user hasn't given a value yet, (c) any
     * declared query params that are missing entirely from the URL.
     */
    function parseUrl(val) {
      const q = val.indexOf('?');
      const pathPart = q >= 0 ? val.slice(0, q) : val;
      const queryPart = q >= 0 ? val.slice(q + 1) : '';
      const queryMap = {}; // key → raw value (may be empty string)
      const keysPresent = new Set();
      if (queryPart) {
        queryPart.split('&').forEach(function(pair) {
          if (!pair) return;
          const eq = pair.indexOf('=');
          const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
          const v = eq >= 0 ? pair.slice(eq + 1) : '';
          keysPresent.add(k);
          queryMap[k] = v;
        });
      }
      return { pathPart: pathPart, queryMap: queryMap, keysPresent: keysPresent };
    }

    function refreshHint() {
      const val = urlInput.value;
      const parsed = parseUrl(val);
      const problems = [];

      // (a) Unresolved {path-token} placeholders in the path segment.
      const tokenRe = /\\{([^{}]+)\\}/g;
      let m;
      const tokens = [];
      while ((m = tokenRe.exec(parsed.pathPart)) !== null) tokens.push(m[1]);
      if (tokens.length > 0) {
        problems.push('path: ' + tokens.map(function(t) { return '{' + esc(t) + '}'; }).join(', '));
      }

      // (b/c) Required query-string params declared by the method but empty
      // or missing from the URL.
      const missingQ = (REQUEST_PARAMS.querystring || [])
        .filter(function(q) { return q.required; })
        .filter(function(q) { return !parsed.queryMap[q.name]; })
        .map(function(q) { return esc(q.name); });
      if (missingQ.length > 0) {
        problems.push('query: ' + missingQ.join(', '));
      }

      if (problems.length > 0) {
        urlHint.innerHTML = 'Fill in <span class="missing">' + problems.join(' · ') + '</span> before sending.';
      } else {
        urlHint.innerHTML = 'Edit the URL directly — replace <code>{tokens}</code> with values, append <code>?key=value</code> for a query string.';
      }
    }
    urlInput.addEventListener('input', refreshHint);
    refreshHint();
    // Enter in the URL bar submits.
    urlInput.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); send(); }
    });

    /* ── Generic key/value editor ────────────────────────────────────────── */
    /*
     * defaults: array of [key, value] or [key, value, required]. When
     * required is true, the row is marked visually (red asterisk) and the
     * key input is disabled so the caller can't rename a declared slot.
     */
    function makeKvGroup(containerId, addBtnId, defaults, countElId) {
      const container = document.getElementById(containerId);
      const countEl = countElId ? document.getElementById(countElId) : null;
      function updateCount() {
        if (!countEl) return;
        let n = 0;
        container.querySelectorAll('.kv-row').forEach(function(row) {
          if (row.querySelector('.kv-k').value.trim()) n += 1;
        });
        countEl.textContent = String(n);
      }
      function addRow(k, v, required) {
        const row = document.createElement('div');
        row.className = 'kv-row' + (required ? ' required' : '');
        const kAttr = required ? ' disabled title="Declared as required by the method"' : '';
        const star = required ? '<span class="req-star" title="required">*</span>' : '';
        row.innerHTML =
          '<input type="text" class="kv-k" placeholder="key" value="' + esc(k || '') + '"' + kAttr + ' />' +
          '<input type="text" class="kv-v" placeholder="' + (required ? 'value (required)' : 'value') + '" value="' + esc(v || '') + '" />' +
          (required
            ? '<span style="display:flex;align-items:center;">' + star + '</span>'
            : '<button type="button" class="kv-remove">×</button>');
        if (!required) {
          row.querySelector('.kv-remove').onclick = function() { row.remove(); updateCount(); };
        }
        row.querySelector('.kv-k').addEventListener('input', updateCount);
        container.appendChild(row);
        updateCount();
      }
      (defaults || []).forEach(function(d) { addRow(d[0], d[1], d[2]); });
      document.getElementById(addBtnId).onclick = function() { addRow('', '', false); };
      return function collect() {
        const out = {};
        const missing = [];
        container.querySelectorAll('.kv-row').forEach(function(row) {
          const k = row.querySelector('.kv-k').value.trim();
          const v = row.querySelector('.kv-v').value;
          if (k) out[k] = v;
          if (row.classList.contains('required') && !v.trim()) missing.push(k);
        });
        return { values: out, missingRequired: missing };
      };
    }
    const collectHeaders = makeKvGroup('headers', 'add-header', PRESEED_HEADERS, 'hdr-count');
    const collectStageVars = makeKvGroup('stage-vars', 'add-stagevar', [], 'sv-count');

    /* ── Path parameter inputs (live-substituted into the URL bar) ─────── */
    // Renders one labeled input per merged path parameter (declared via
    // method.request.path.* AND/OR present in the URL as {token}). Typing
    // into an input rewrites the token in the URL bar live — AWS Console's
    // Test tab behaviour, but skips the manual round-trip. State per row
    // remembers the previously-substituted value so subsequent edits can
    // find and replace the old text instead of chasing a lost {name} token.
    (function renderPathParams() {
      if (!PATH_PARAMS || PATH_PARAMS.length === 0) return;
      const section = document.getElementById('path-section');
      const container = document.getElementById('path-params');
      const countEl = document.getElementById('path-count');
      section.style.display = '';
      countEl.textContent = String(PATH_PARAMS.length);
      container.innerHTML = PATH_PARAMS.map(function(p) {
        const star = p.required ? '<span class="req-star" title="required">*</span>' : '';
        const badge = p.inUrl
          ? '<span class="pp-badge in-url" title="present in the URL template">in path</span>'
          : '<span class="pp-badge missing" title="declared but not present in the current URL — add it manually if needed">declared only</span>';
        return '<div class="pp-row" data-pp-name="' + esc(p.name) + '" data-pp-required="' + (p.required ? '1' : '0') + '" data-pp-in-url="' + (p.inUrl ? '1' : '0') + '">' +
          '<label class="pp-label"><code>' + esc(p.name) + '</code>' + star + badge + '</label>' +
          '<input type="text" class="pp-val" placeholder="value" />' +
        '</div>';
      }).join('');

      // API Gateway path-parameter names only permit [A-Za-z0-9._-], so no
      // regex escaping is required when we build a \\{name\\} matcher.

      container.querySelectorAll('.pp-row').forEach(function(row) {
        const name = row.getAttribute('data-pp-name');
        const inUrl = row.getAttribute('data-pp-in-url') === '1';
        const input = row.querySelector('.pp-val');
        // Remembered value so we can replace *what we last inserted* on the
        // next edit. Starts as the {name} token if it's present in the URL.
        let currentSubstitution = inUrl ? '{' + name + '}' : null;

        input.addEventListener('input', function() {
          const newVal = input.value;
          let url = urlInput.value;
          if (currentSubstitution !== null && url.indexOf(currentSubstitution) !== -1) {
            // Replace only the FIRST occurrence — path params can legitimately
            // repeat elsewhere in the URL (rare, but keep the intent local).
            const idx = url.indexOf(currentSubstitution);
            url = url.slice(0, idx) + (newVal === '' ? '{' + name + '}' : encodeURIComponent(newVal)) + url.slice(idx + currentSubstitution.length);
          } else if (newVal !== '') {
            // We lost track of where this param went (user edited the URL
            // directly). Try the {name} token as a fallback; if that's gone
            // too, we can't safely inject — the user is in charge.
            const tokenRe = new RegExp('\\\\{' + name + '\\\\}');
            if (tokenRe.test(url)) {
              url = url.replace(tokenRe, encodeURIComponent(newVal));
            }
            // Otherwise: silent no-op. The URL bar edit wins.
          }
          urlInput.value = url;
          currentSubstitution = newVal === '' ? '{' + name + '}' : encodeURIComponent(newVal);
          refreshHint();
        });
      });
    })();

    /* ── Response tabs ───────────────────────────────────────────────────── */
    document.querySelectorAll('.resp-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        const target = tab.getAttribute('data-tab');
        document.querySelectorAll('.resp-tab').forEach(function(t) { t.classList.toggle('active', t === tab); });
        document.querySelectorAll('.resp-pane').forEach(function(p) {
          p.classList.toggle('active', p.getAttribute('data-pane') === target);
        });
      });
    });

    /* ── Send ────────────────────────────────────────────────────────────── */
    const runBtn = document.getElementById('run-btn');
    function send() {
      const val = urlInput.value.trim();
      if (!val) { showError('URL is empty.'); return; }

      // Guard: no unresolved {tokens} — AWS would return a confusing 500.
      const unresolved = (val.match(/\\{[^{}]+\\}/g) || []);
      if (unresolved.length > 0) {
        showError('Unresolved path token(s): ' + unresolved.join(', '));
        return;
      }

      // Guard: declared required query params must have values.
      const parsed = parseUrl(val);
      const missingQ = (REQUEST_PARAMS.querystring || [])
        .filter(function(q) { return q.required; })
        .filter(function(q) { return !parsed.queryMap[q.name]; })
        .map(function(q) { return q.name; });
      if (missingQ.length > 0) {
        showError('Missing required query parameter(s): ' + missingQ.join(', '));
        return;
      }

      // Guard: declared required headers must have values.
      const headers = collectHeaders();
      const stageVars = collectStageVars();
      if (headers.missingRequired.length > 0) {
        showError('Missing required header(s): ' + headers.missingRequired.join(', '));
        return;
      }

      // Ensure leading slash — TestInvokeMethod expects an absolute path.
      const pathWithQuery = val.startsWith('/') ? val : '/' + val;
      runBtn.disabled = true;
      runBtn.textContent = 'Sending…';
      vscode.postMessage({
        type: 'test',
        payload: {
          pathWithQuery: pathWithQuery,
          headers: headers.values,
          stageVariables: stageVars.values,
          body: document.getElementById('body').value,
        },
      });
    }
    runBtn.onclick = send;

    /* ── Response render ─────────────────────────────────────────────────── */
    function statusClass(s) {
      if (!s) return '';
      if (s < 300) return 's2xx';
      if (s < 400) return 's3xx';
      if (s < 500) return 's4xx';
      return 's5xx';
    }
    function fmtHeaders(h) {
      return Object.keys(h || {}).map(function(k) { return k + ': ' + h[k]; }).join('\\n');
    }
    function prettyBody(s) {
      if (!s) return '(empty body)';
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; }
    }

    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (m.type === 'response') {
        runBtn.disabled = false;
        runBtn.textContent = 'Send';
        document.getElementById('resp-empty').style.display = 'none';
        document.getElementById('resp-content').style.display = '';
        const st = document.getElementById('resp-status');
        st.textContent = String(m.status || '—');
        st.className = 'status-badge ' + statusClass(m.status);
        const latencyBits = [];
        if (m.latencyMs != null) latencyBits.push('server ' + m.latencyMs + 'ms');
        if (m.roundTripMs != null) latencyBits.push('round-trip ' + m.roundTripMs + 'ms');
        document.getElementById('resp-latency').textContent = latencyBits.join(' · ');
        document.getElementById('resp-body-pane').textContent = prettyBody(m.body);
        const headersText = fmtHeaders(m.headers);
        document.getElementById('resp-headers-pane').textContent = headersText || '(no headers)';
        document.getElementById('resp-hdr-count').textContent = '(' + Object.keys(m.headers || {}).length + ')';
        document.getElementById('resp-log-pane').textContent = m.log || '(no execution log returned — check that API logging is enabled)';
        document.getElementById('resp-path-pane').textContent = m.pathWithQuery || '';
        // Scroll response into view so users see it without hunting.
        document.querySelector('.response').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (m.type === 'error') {
        runBtn.disabled = false;
        runBtn.textContent = 'Send';
        showError(m.message);
      }
    });
  </script>
</body>
</html>`;
  }
}

// ─── Types + helpers ───────────────────────────────────────────────────────

/** Route identifier passed in by the caller (from the routes panel). */
export interface RestRouteRef {
  resourceId: string;
  method: string;
  /** Template path with `{param}` placeholders — e.g. `/streams/{stream-name}/record`. */
  path: string;
  /**
   * Parsed `method.requestParameters` — the declared query-string / header /
   * path contract for this method. Used to prefill the URL bar with known
   * slots (`?eastWeight=&westWeight=`), pre-add required header rows, and
   * flag any required slots still empty before send.
   */
  requestParams?: {
    querystring: Array<{ name: string; required: boolean }>;
    header: Array<{ name: string; required: boolean }>;
    path: Array<{ name: string; required: boolean }>;
  };
}

interface TestPayload {
  /** Full path + query string as typed in the URL bar (e.g. `/streams/foo/record?x=1`). */
  pathWithQuery: string;
  headers: Record<string, string>;
  stageVariables: Record<string, string>;
  body: string;
}

function panelKey(apiArn: string, route: RestRouteRef): string {
  return `${apiArn}::${route.resourceId}::${route.method}`;
}

/**
 * Pull `{foo}` tokens out of a template path. Only used for the URL-bar hint
 * that lists remaining unfilled placeholders — actual substitution is done
 * by the user editing the URL bar directly.
 */
function extractPathParams(templatePath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(templatePath)) !== null) {
    // Strip trailing `+` (greedy proxy) — syntax, not part of the name.
    const name = m[1].replace(/\+$/, "");
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * Whether the given HTTP method typically carries a request body. Used to
 * auto-open the Body section for POST/PUT/PATCH/DELETE and leave it closed
 * for GET/HEAD/OPTIONS.
 */
function bodyRelevant(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE", "ANY"].includes(method.toUpperCase());
}
