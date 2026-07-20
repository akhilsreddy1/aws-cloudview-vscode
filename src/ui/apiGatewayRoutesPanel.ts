import * as vscode from "vscode";
import {
  GetResourcesCommand,
  GetMethodCommand,
  type Method as RestMethod,
} from "@aws-sdk/client-api-gateway";
import {
  GetRoutesCommand,
  GetIntegrationsCommand,
  type Integration as V2Integration,
} from "@aws-sdk/client-apigatewayv2";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";
import { ApiGatewayTestPanel } from "./apiGatewayTestPanel";

/**
 * Per-API drilldown showing the route → integration mapping that the
 * dashboard intentionally omits (routes can number in the hundreds for a
 * single API — bloating the cache made no sense). Lazy-loads on open via
 * `GetResources`+`GetMethod` for REST APIs or flat `GetRoutes`+`GetIntegrations`
 * for v2 APIs.
 *
 * Read-only. Drilldown for understanding; doesn't mutate anything.
 */
export class ApiGatewayRoutesPanel {
  private static panels = new Map<string, ApiGatewayRoutesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly apiId: string;
  private readonly isV2: boolean;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.apiId = resource.id;
    this.isV2 = resource.type === ResourceTypes.apiGatewayV2Api;

    const protocol = (resource.rawJson.ProtocolType as string) || (this.isV2 ? "HTTP" : "REST");
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewApiGatewayRoutes",
      `${protocol} API: ${resource.name || this.apiId}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => ApiGatewayRoutesPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          await this.loadRoutes();
        } else if (msg.type === "refresh") {
          await this.loadRoutes();
        } else if (msg.type === "openIntegration" && typeof msg.targetArn === "string") {
          await vscode.commands.executeCommand("cloudView.openGraphView.fromArn", msg.targetArn);
        } else if (msg.type === "invokeIntegration" && typeof msg.targetArn === "string" && typeof msg.kind === "string") {
          // Dispatch to the right existing invoke panel based on integration kind.
          // We deliberately reuse Lambda/SFN panels rather than reinventing the
          // request shape — these panels already handle payload templating,
          // history, etc.
          if (msg.kind === "lambda") {
            await vscode.commands.executeCommand("cloudView.invokeLambda", msg.targetArn);
          } else if (msg.kind === "stepfunctions") {
            await vscode.commands.executeCommand("cloudView.executeStateMachine", msg.targetArn);
          }
        } else if (
          msg.type === "openTestPanel" &&
          typeof msg.resourceId === "string" &&
          typeof msg.method === "string" &&
          typeof msg.path === "string"
        ) {
          // Route → dedicated Test panel that drives TestInvokeMethod. REST
          // only — v2 rows never expose the button.
          await ApiGatewayTestPanel.open(this.platform, this.resource, {
            resourceId: msg.resourceId,
            method: msg.method,
            path: msg.path,
            requestParams: (msg.requestParams as {
              querystring: Array<{ name: string; required: boolean }>;
              header: Array<{ name: string; required: boolean }>;
              path: Array<{ name: string; required: boolean }>;
            } | undefined) ?? undefined,
          });
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    if (
      resource.type !== ResourceTypes.apiGatewayRestApi &&
      resource.type !== ResourceTypes.apiGatewayV2Api
    ) {
      void vscode.window.showWarningMessage(
        "Routes view only supports REST or HTTP/WebSocket APIs, not stages.",
      );
      return;
    }
    const existing = ApiGatewayRoutesPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new ApiGatewayRoutesPanel(platform, resource);
    ApiGatewayRoutesPanel.panels.set(resource.arn, instance);
  }

  // ─── Load routes ────────────────────────────────────────────────────────

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadRoutes(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    void this.panel.webview.postMessage({ type: "loading" });
    try {
      const rows = this.isV2 ? await this.loadV2Routes(scope) : await this.loadRestRoutes(scope);
      void this.panel.webview.postMessage({ type: "routes", rows });
    } catch (err: unknown) {
      this.postError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * For REST APIs: fetch all resources (paths), then per-method `GetMethod`
   * to read the integration. This is the only way to get integration data
   * for v1 — the SDK has no flat list-integrations call.
   *
   * Cost: O(resources × methods). For a 50-resource API with ~4 methods each
   * that's ~200 calls, scheduler-throttled. Surface a progress percentage so
   * the user sees motion on large APIs.
   */
  private async loadRestRoutes(scope: {
    profileName: string; accountId: string; region: string;
  }): Promise<RouteRow[]> {
    const client = await this.platform.awsClientFactory.apiGateway(scope);

    // Pull all resources first (paginated).
    type ResourceItem = { id: string; path: string; methods: string[] };
    const items: ResourceItem[] = [];
    let position: string | undefined;
    do {
      const resp = await this.platform.scheduler.run("apigateway", "GetResources", () =>
        client.send(new GetResourcesCommand({ restApiId: this.apiId, position, limit: 500 }))
      );
      for (const r of resp.items ?? []) {
        if (r.id && r.path && r.resourceMethods) {
          items.push({ id: r.id, path: r.path, methods: Object.keys(r.resourceMethods) });
        }
      }
      position = resp.position;
    } while (position);

    // Count total methods upfront for progress reporting.
    const totalMethods = items.reduce((acc, i) => acc + i.methods.length, 0);
    let completed = 0;
    if (totalMethods > 0) {
      void this.panel.webview.postMessage({ type: "progress", completed: 0, total: totalMethods });
    }

    const rows: RouteRow[] = [];
    for (const item of items) {
      for (const httpMethod of item.methods) {
        let methodResp;
        try {
          methodResp = await this.platform.scheduler.run("apigateway", "GetMethod", () =>
            client.send(new GetMethodCommand({
              restApiId: this.apiId, resourceId: item.id, httpMethod,
            }))
          );
        } catch {
          completed += 1;
          continue; // permission error on a single method shouldn't kill the table
        }
        rows.push(restRowFromMethod(item.path, httpMethod, methodResp, item.id));
        completed += 1;
        // Throttle progress updates a bit so we're not blasting messages.
        if (completed % 10 === 0 || completed === totalMethods) {
          void this.panel.webview.postMessage({ type: "progress", completed, total: totalMethods });
        }
      }
    }
    return rows;
  }

  /**
   * For v2 APIs: flat `GetIntegrations` + `GetRoutes`, then join by integration id.
   * Much cheaper than the v1 per-method dance — typically two API calls total.
   */
  private async loadV2Routes(scope: {
    profileName: string; accountId: string; region: string;
  }): Promise<RouteRow[]> {
    const client = await this.platform.awsClientFactory.apiGatewayV2(scope);

    // Pull all integrations into a map keyed by integration id (Routes
    // reference integrations as `integrations/<id>` in their Target field).
    const integrations = new Map<string, V2Integration>();
    {
      let nextToken: string | undefined;
      do {
        const resp = await this.platform.scheduler.run("apigatewayv2", "GetIntegrations", () =>
          client.send(new GetIntegrationsCommand({
            ApiId: this.apiId, NextToken: nextToken, MaxResults: "100",
          }))
        );
        for (const integ of resp.Items ?? []) {
          if (integ.IntegrationId) integrations.set(integ.IntegrationId, integ);
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    }

    const rows: RouteRow[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await this.platform.scheduler.run("apigatewayv2", "GetRoutes", () =>
        client.send(new GetRoutesCommand({
          ApiId: this.apiId, NextToken: nextToken, MaxResults: "100",
        }))
      );
      for (const route of resp.Items ?? []) {
        // RouteKey is `METHOD /path` for HTTP, or `$default` / `$connect` etc. for WebSocket.
        const routeKey = route.RouteKey ?? "";
        const [methodRaw, ...pathParts] = routeKey.split(" ");
        const method = methodRaw || "ANY";
        const path = pathParts.join(" ") || (methodRaw.startsWith("$") ? "" : "/");

        // Target format: "integrations/<id>"
        const integrationId = route.Target?.startsWith("integrations/")
          ? route.Target.slice("integrations/".length)
          : undefined;
        const integ = integrationId ? integrations.get(integrationId) : undefined;

        rows.push(v2RowFromRoute(method, path, route.AuthorizationType, integ));
      }
      nextToken = resp.NextToken;
    } while (nextToken);

    // Sort by path then method for readability — v2 returns in creation order which is rarely useful.
    rows.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
    return rows;
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  // ─── HTML ───────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const n = generateNonce();
    const apiName = escapeHtml(this.resource.name || this.apiId);
    const apiId = escapeHtml(this.apiId);
    const region = escapeHtml(this.resource.region);
    const account = escapeHtml(this.resource.accountId);
    const protocol = escapeHtml((this.resource.rawJson.ProtocolType as string) ?? (this.isV2 ? "HTTP" : "REST"));
    const endpoint = escapeHtml(
      (this.resource.rawJson.Endpoint as string) ||
      (this.resource.rawJson.ApiEndpoint as string) ||
      "",
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>${apiName} routes</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #7c3aed; font-size: 20px; }
    .meta { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono', 'Fira Code', monospace; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .toolbar .grow { flex: 1; }
    .toolbar input.cv-search {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px; min-width: 240px;
    }
    .btn {
      background: var(--accent); color: white; border: none;
      padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
      cursor: pointer;
    }
    .btn:hover { background: #e68a00; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }

    .progress { padding: 8px 20px; font-size: 11px; color: var(--muted); background: var(--surface-2); border-bottom: 1px solid var(--border); flex-shrink: 0; display: none; }
    .progress .bar { display: inline-block; width: 200px; height: 8px; background: var(--border-2); border-radius: 4px; vertical-align: middle; overflow: hidden; margin-left: 8px; }
    .progress .bar-fill { display: block; height: 100%; background: #7c3aed; width: 0%; transition: width .2s; }

    .content { flex: 1; overflow: auto; background: var(--surface); }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 60px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    table.routes {
      border-collapse: collapse; font-size: 12px; width: 100%;
    }
    table.routes thead th {
      background: var(--surface-2); position: sticky; top: 0; z-index: 1;
      border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left;
      font-weight: 700; color: var(--text); white-space: nowrap;
      font-size: 11px; text-transform: uppercase; letter-spacing: .3px;
    }
    table.routes tbody td {
      padding: 6px 10px; border-bottom: 1px solid var(--border);
      vertical-align: top; color: var(--text);
    }
    table.routes tbody tr:hover td { background: var(--surface-2); }

    .method-pill {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-weight: 700; font-size: 11px; font-family: 'SF Mono', 'Fira Code', monospace;
      min-width: 60px; text-align: center;
    }
    .method-pill.GET { background: #dcfce7; color: #166534; }
    .method-pill.POST { background: #dbeafe; color: #1e40af; }
    .method-pill.PUT { background: #fef3c7; color: #92400e; }
    .method-pill.PATCH { background: #fef3c7; color: #92400e; }
    .method-pill.DELETE { background: #fee2e2; color: #991b1b; }
    .method-pill.OPTIONS, .method-pill.HEAD, .method-pill.ANY { background: #e5e7eb; color: #374151; }
    .method-pill.\\$default, .method-pill.\\$connect, .method-pill.\\$disconnect { background: #ede9fe; color: #5b21b6; }

    .path { font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all; }

    .integ-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 10px;
      background: var(--surface-2); color: var(--text);
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px;
      max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .integ-chip.lambda { background: #fef3c7; color: #92400e; cursor: pointer; }
    .integ-chip.lambda:hover { background: #fde68a; }
    .integ-chip.stepfunctions { background: #ede9fe; color: #5b21b6; cursor: pointer; }
    .integ-chip.stepfunctions:hover { background: #ddd6fe; }
    .integ-chip.http { background: #dbeafe; color: #1e40af; }
    .integ-chip.service { background: #dcfce7; color: #166534; }
    .integ-chip.mock { background: #e5e7eb; color: #374151; }
    .integ-chip.vpc { background: #ede9fe; color: #5b21b6; }
    .integ-chip.none { background: transparent; color: var(--muted); font-style: italic; }

    .invoke-btn {
      background: transparent; border: 1px solid var(--accent); color: var(--accent);
      padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
      cursor: pointer; transition: background .15s;
      font-family: inherit;
    }
    .invoke-btn:hover { background: rgba(255,153,0,0.12); }
    .invoke-btn:disabled { opacity: .35; cursor: default; border-color: var(--border-2); color: var(--muted); }

    .info-banner {
      background: rgba(124,58,237,0.08); color: var(--text);
      border-bottom: 1px solid var(--border);
      padding: 8px 20px; font-size: 11px; line-height: 1.5;
      display: flex; gap: 10px; align-items: flex-start; flex-shrink: 0;
    }
    .info-banner .info-icon { font-size: 14px; line-height: 1.2; }
    .info-banner strong { color: var(--text); }
    .info-banner code { font-family: 'SF Mono', 'Fira Code', monospace; background: rgba(0,0,0,0.04); padding: 1px 4px; border-radius: 3px; }

    .auth-chip {
      display: inline-block; padding: 1px 6px; border-radius: 8px;
      font-size: 10px; text-transform: uppercase; letter-spacing: .3px;
      background: var(--surface-2); color: var(--muted);
    }
    .auth-chip.NONE { color: var(--muted); }
    .auth-chip.AWS_IAM, .auth-chip.CUSTOM, .auth-chip.JWT, .auth-chip.COGNITO_USER_POOLS { background: #fef3c7; color: #92400e; }

    .count-pill { font-size: 11px; color: var(--muted); }

    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none;
    }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title">
      <span class="icon">\u{1F517}</span>
      <span>${apiName}</span>
      <span class="auth-chip">${protocol}</span>
    </div>
    <div class="meta">
      <span><span class="label">API ID:</span> <code>${apiId}</code></span>
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Account:</span> <code>${account}</code></span>
      ${endpoint ? `<span><span class="label">Endpoint:</span> <code>${endpoint}</code></span>` : ""}
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="info-banner">
    <span class="info-icon">\u{2139}\u{FE0F}</span>
    <div>
      <strong>Two ways to exercise a route</strong> — <code>▶ Invoke</code> calls the <em>backing</em>
      Lambda or Step Function directly, bypassing API Gateway (skips request templates, auth, throttling).
      <code>▶ Test</code> uses <code>TestInvokeMethod</code> — the same call AWS Console's Test tab uses:
      runs the full API-Gateway pipeline (path params, VTL, integration invocation) end-to-end and returns
      the response plus the execution log, but bypasses the deployed stage so no deploy is required. Test
      is REST-only; v2 HTTP/WebSocket routes must be tested against their deployed stage URL.
    </div>
  </div>

  <div class="toolbar">
    <input class="cv-search" id="filter" type="text" placeholder="Filter routes by path, method, or integration…" autofocus>
    <span class="count-pill" id="count">0 routes</span>
    <span class="grow"></span>
    <button class="btn ghost" id="refresh-btn" title="Re-fetch routes from AWS">↻ Refresh</button>
  </div>

  <div class="progress" id="progress">
    <span id="progress-text">Loading…</span>
    <span class="bar"><span class="bar-fill" id="progress-fill"></span></span>
  </div>

  <div class="content">
    <div class="empty-state" id="empty">
      <div class="icon">\u{1F517}</div>
      <div>Loading routes…</div>
    </div>
    <table class="routes" id="routes-table" style="display:none;">
      <thead>
        <tr>
          <th style="width:80px;">Method</th>
          <th style="width:40%;">Path</th>
          <th>Integration</th>
          <th style="width:90px;">Auth</th>
          <th style="width:100px;">Invoke</th>
          <th style="width:100px;">Test</th>
        </tr>
      </thead>
      <tbody id="routes-body"></tbody>
    </table>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var filterInput = document.getElementById('filter');
    var refreshBtn = document.getElementById('refresh-btn');
    var emptyEl = document.getElementById('empty');
    var table = document.getElementById('routes-table');
    var tbody = document.getElementById('routes-body');
    var countEl = document.getElementById('count');
    var errorBanner = document.getElementById('error-banner');
    var progress = document.getElementById('progress');
    var progressFill = document.getElementById('progress-fill');
    var progressText = document.getElementById('progress-text');
    var allRows = [];

    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      setTimeout(function(){ errorBanner.style.display = 'none'; }, 8000);
    }

    function integChipClass(kind) {
      switch (kind) {
        case 'lambda': return 'lambda';
        case 'stepfunctions': return 'stepfunctions';
        case 'http': return 'http';
        case 'service': return 'service';
        case 'mock': return 'mock';
        case 'vpc': return 'vpc';
        default: return 'none';
      }
    }

    function invokeLabel(kind) {
      if (kind === 'lambda') return '▶ Invoke';
      if (kind === 'stepfunctions') return '▶ Execute';
      return '';
    }

    function methodClass(m) {
      // CSS class names can't start with $, so we encode $default as the bare class.
      if (m && m.charAt(0) === '$') return '\\\\$' + m.slice(1);
      return m;
    }

    function render(rows) {
      if (!rows.length) {
        table.style.display = 'none';
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'No routes match the filter.';
        countEl.textContent = '0 of ' + allRows.length + ' routes';
        return;
      }
      emptyEl.style.display = 'none';
      table.style.display = '';
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var methodCls = r.method.charAt(0) === '$' ? '' : r.method;
        var integLabel = r.integrationLabel || '(no integration)';
        var integKind = r.integrationKind || 'none';
        // Chips are clickable for any kind that has a discoverable ARN —
        // currently Lambda and Step Functions resolve to graph nodes.
        var chipClickable = (integKind === 'lambda' || integKind === 'stepfunctions') && r.integrationTargetArn;
        var chipAttrs = chipClickable
          ? ' data-graph-arn="' + esc(r.integrationTargetArn) + '" title="Open this resource in the graph view"'
          : (r.integrationTargetArn ? ' title="' + esc(r.integrationTargetArn) + '"' : '');

        // Invoke button: visible only when we know how to invoke the target.
        // Step Functions REST integrations sometimes hide the SM ARN inside
        // a VTL template we couldn't parse — the button is disabled in that
        // case but still shown so the user knows the route is invokable in
        // principle.
        var invKind = r.invokableKind || '';
        var invArn = r.invokableTargetArn || '';
        var invokeCell;
        if (invKind && invArn) {
          invokeCell = '<button class="invoke-btn" data-invoke-kind="' + esc(invKind) +
            '" data-invoke-arn="' + esc(invArn) +
            '" title="Invoke the backing ' + (invKind === 'lambda' ? 'Lambda function' : 'Step Function') + ' directly">' +
            invokeLabel(invKind) + '</button>';
        } else if (integKind === 'stepfunctions' || integKind === 'lambda') {
          invokeCell = '<button class="invoke-btn" disabled title="Backing ARN couldn\\'t be extracted from the integration definition">▶</button>';
        } else {
          invokeCell = '<span style="color:var(--muted);font-size:11px;">\\u2014</span>';
        }

        // Test button: REST-only (resourceId is undefined on v2 rows). Drives
        // TestInvokeMethod — actually runs the route's integration end-to-end
        // (VTL templates → integration call → response mapping) but bypasses
        // the deployed stage, so it works even for un-deployed changes.
        var testCell;
        if (r.resourceId) {
          // JSON-encode the request-parameter contract so the panel can
          // prefill known slots and flag missing required inputs.
          // Base64-encode the JSON before stuffing it into a data-* attribute:
          // the webview esc() does not escape double quotes, so a raw JSON
          // attribute value would silently truncate at the first quote char.
          var paramsJson = JSON.stringify(r.requestParams || {querystring:[],header:[],path:[]});
          var paramsB64 = btoa(unescape(encodeURIComponent(paramsJson)));
          testCell = '<button class="invoke-btn cv-test-btn"' +
            ' data-test-resource-id="' + esc(r.resourceId) + '"' +
            ' data-test-method="' + esc(r.method) + '"' +
            ' data-test-path="' + esc(r.path) + '"' +
            ' data-test-params-b64="' + paramsB64 + '"' +
            ' title="Send a test request through the full API-Gateway pipeline (bypasses the deployed stage)">▶ Test</button>';
        } else {
          testCell = '<span style="color:var(--muted);font-size:11px;" title="TestInvokeMethod is REST-only; HTTP/WebSocket APIs must be tested against their deployed stage URL.">\\u2014</span>';
        }

        html += '<tr>' +
          '<td><span class="method-pill ' + esc(methodCls) + '">' + esc(r.method) + '</span></td>' +
          '<td class="path">' + esc(r.path) + '</td>' +
          '<td><span class="integ-chip ' + integChipClass(integKind) + '"' + chipAttrs + '>' + esc(integLabel) + '</span></td>' +
          '<td><span class="auth-chip ' + esc(r.authorizationType || 'NONE') + '">' + esc(r.authorizationType || 'NONE') + '</span></td>' +
          '<td>' + invokeCell + '</td>' +
          '<td>' + testCell + '</td>' +
          '</tr>';
      }
      tbody.innerHTML = html;
      countEl.textContent = rows.length === allRows.length
        ? rows.length + ' route' + (rows.length === 1 ? '' : 's')
        : rows.length + ' of ' + allRows.length + ' routes';

      // Wire chip clicks → open graph view at that resource
      tbody.querySelectorAll('[data-graph-arn]').forEach(function(chip) {
        chip.onclick = function() {
          vscode.postMessage({ type: 'openIntegration', targetArn: chip.getAttribute('data-graph-arn') });
        };
      });
      // Wire invoke buttons → dispatch to existing Lambda/SFN invoke panels
      tbody.querySelectorAll('button.invoke-btn[data-invoke-arn]').forEach(function(btn) {
        btn.onclick = function() {
          vscode.postMessage({
            type: 'invokeIntegration',
            kind: btn.getAttribute('data-invoke-kind'),
            targetArn: btn.getAttribute('data-invoke-arn'),
          });
        };
      });
      // Wire Test buttons → open the per-route TestInvokeMethod panel
      tbody.querySelectorAll('button.cv-test-btn').forEach(function(btn) {
        btn.onclick = function() {
          var paramsB64 = btn.getAttribute('data-test-params-b64') || '';
          var params;
          try {
            var paramsJson = paramsB64 ? decodeURIComponent(escape(atob(paramsB64))) : '{}';
            params = JSON.parse(paramsJson);
          } catch (_) { params = undefined; }
          vscode.postMessage({
            type: 'openTestPanel',
            resourceId: btn.getAttribute('data-test-resource-id'),
            method: btn.getAttribute('data-test-method'),
            path: btn.getAttribute('data-test-path'),
            requestParams: params,
          });
        };
      });
    }

    function applyFilter() {
      var q = filterInput.value.trim().toLowerCase();
      if (!q) { render(allRows); return; }
      var filtered = allRows.filter(function(r) {
        return r.method.toLowerCase().indexOf(q) !== -1
          || r.path.toLowerCase().indexOf(q) !== -1
          || (r.integrationLabel || '').toLowerCase().indexOf(q) !== -1
          || (r.authorizationType || '').toLowerCase().indexOf(q) !== -1;
      });
      render(filtered);
    }

    filterInput.addEventListener('input', applyFilter);
    refreshBtn.addEventListener('click', function() {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '…';
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', function(ev) {
      var m = ev.data;
      if (m.type === 'loading') {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div:nth-child(2)').textContent = 'Loading routes…';
        table.style.display = 'none';
        progress.style.display = 'none';
      } else if (m.type === 'progress') {
        progress.style.display = 'block';
        var pct = m.total > 0 ? Math.floor((m.completed / m.total) * 100) : 0;
        progressFill.style.width = pct + '%';
        progressText.textContent = 'Loading: ' + m.completed + ' / ' + m.total + ' methods';
      } else if (m.type === 'routes') {
        progress.style.display = 'none';
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ Refresh';
        allRows = m.rows || [];
        if (allRows.length === 0) {
          emptyEl.style.display = 'flex';
          emptyEl.querySelector('div:nth-child(2)').textContent = 'No routes found in this API.';
          table.style.display = 'none';
          countEl.textContent = '0 routes';
        } else {
          applyFilter();
        }
      } else if (m.type === 'error') {
        progress.style.display = 'none';
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ Refresh';
        showError(m.message || 'Unknown error');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Row builders ───────────────────────────────────────────────────────────

/**
 * Serializable shape sent to the webview — one per route/method row.
 *
 * - `integrationKind` drives the chip color/style; `integrationLabel` is
 *   the human-readable target ("my-lambda-function" or "https://api.foo.com").
 * - `integrationTargetArn` is set when the target is a discoverable AWS
 *   resource so the chip can deep-link into the graph view.
 * - `invokableKind` + `invokableTargetArn` enable the ▶ Invoke button —
 *   for integrations that route to something we know how to invoke
 *   directly via existing panels (Lambda Invoke or Step Functions Execute).
 *   When `invokableKind` is undefined, the Invoke button is hidden.
 */
interface RouteRow {
  method: string;
  path: string;
  authorizationType?: string;
  integrationKind?: "lambda" | "http" | "service" | "mock" | "vpc" | "stepfunctions" | "none";
  integrationLabel?: string;
  integrationTargetArn?: string;
  invokableKind?: "lambda" | "stepfunctions";
  invokableTargetArn?: string;
  /**
   * REST-only: API Gateway resource id required for `TestInvokeMethod`.
   * v2 (HTTP/WebSocket) rows leave this undefined — v2 has no server-side
   * TestInvoke equivalent, so the Test button hides itself for those.
   */
  resourceId?: string;
  /**
   * REST-only: parsed `method.request.*` parameter contract so the Test
   * panel can prefill the URL / headers with known slots and flag missing
   * required inputs before send. Each entry's boolean is `true` when
   * required. Undefined for v2 rows.
   */
  requestParams?: {
    querystring: Array<{ name: string; required: boolean }>;
    header: Array<{ name: string; required: boolean }>;
    path: Array<{ name: string; required: boolean }>;
  };
}

interface ClassifiedIntegration {
  kind: RouteRow["integrationKind"];
  label: string;
  /** ARN of the resource for the graph-view deep link (Lambda/SFN). */
  targetArn?: string;
  /** ARN of an invokable target — drives the ▶ Invoke button. */
  invokableKind?: RouteRow["invokableKind"];
  invokableTargetArn?: string;
}

/**
 * Classify an API Gateway integration:
 *   - Recognise Lambda / Step Functions / HTTP / AWS-service / mock.
 *   - For Lambda + Step Functions, extract the backing ARN so users can
 *     invoke the integration target directly (bypassing API Gateway).
 *
 * @param uri              Integration URI (v1 `methodIntegration.uri` or v2 `Integration.IntegrationUri`).
 * @param integrationType  v1 `type` or v2 `IntegrationType` (`AWS`, `AWS_PROXY`, `HTTP_PROXY`, `MOCK`, ...).
 * @param v2Subtype        v2-only `Integration.IntegrationSubtype` (e.g. `StepFunctions-StartExecution`).
 * @param v2RequestParams  v2-only `Integration.RequestParameters` — where the StateMachineArn lives for SFN integrations.
 * @param v1RequestTemplates v1-only `methodIntegration.requestTemplates` — VTL where the SM ARN may be embedded for REST→Step Functions.
 */
function classifyIntegration(
  uri: string | undefined,
  integrationType: string | undefined,
  v2Subtype?: string,
  v2RequestParams?: Record<string, string>,
  v1RequestTemplates?: Record<string, string>,
): ClassifiedIntegration {
  if (!uri || !integrationType || integrationType === "MOCK") {
    return { kind: "mock", label: "(mock)" };
  }

  // ── Step Functions (v2 IntegrationSubtype path) ──────────────────────
  // v2 HTTP APIs use a first-class subtype + RequestParameters.StateMachineArn.
  // This is the clean, reliable case.
  if (v2Subtype && /^StepFunctions-Start(Sync)?Execution$/i.test(v2Subtype)) {
    const smArn = v2RequestParams?.StateMachineArn;
    const name = smArn?.split(":stateMachine:")[1];
    return {
      kind: "stepfunctions",
      label: name ? `⚙️ sfn:${name}` : `⚙️ Step Functions`,
      targetArn: smArn,
      invokableKind: smArn ? "stepfunctions" : undefined,
      invokableTargetArn: smArn,
    };
  }

  // ── Lambda ─────────────────────────────────────────────────────────────
  // Two common URI forms:
  //   arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<lambda-arn>/invocations
  //   <lambda-arn>  (v2 sometimes normalizes to this)
  const lambdaPath = uri.match(/\/functions\/(arn:aws:lambda:[^/]+:[^:]+:function:[^/]+)/);
  if (lambdaPath) {
    const arn = lambdaPath[1];
    const name = arn.split(":function:")[1] ?? arn;
    return {
      kind: "lambda",
      label: `λ ${name}`,
      targetArn: arn,
      invokableKind: "lambda",
      invokableTargetArn: arn,
    };
  }
  if (uri.startsWith("arn:aws:lambda:") && uri.includes(":function:")) {
    const arn = uri.split("/")[0];
    const name = arn.split(":function:")[1] ?? arn;
    return {
      kind: "lambda",
      label: `λ ${name}`,
      targetArn: arn,
      invokableKind: "lambda",
      invokableTargetArn: arn,
    };
  }

  // ── Step Functions (v1 REST path) ──────────────────────────────────────
  // REST integrations call `states:action/StartExecution`. The state-machine
  // ARN lives inside the request template as JSON. We best-effort regex it;
  // if that fails, we still surface the row as Step Functions but skip the
  // invoke button (user can invoke via the Step Functions service tree).
  if (/^arn:aws:apigateway:[^:]+:states:/i.test(uri)) {
    let smArn: string | undefined;
    if (v1RequestTemplates) {
      for (const template of Object.values(v1RequestTemplates)) {
        const m = template.match(/arn:aws:states:[^"'\s\\]+:stateMachine:[A-Za-z0-9_-]+/);
        if (m) { smArn = m[0]; break; }
      }
    }
    const name = smArn?.split(":stateMachine:")[1];
    return {
      kind: "stepfunctions",
      label: name ? `⚙️ sfn:${name}` : `⚙️ Step Functions`,
      targetArn: smArn,
      invokableKind: smArn ? "stepfunctions" : undefined,
      invokableTargetArn: smArn,
    };
  }

  // ── HTTP / HTTP_PROXY — plain URL ───────────────────────────────────────
  if (integrationType === "HTTP" || integrationType === "HTTP_PROXY") {
    return { kind: "http", label: uri };
  }
  // ── AWS service integration (other than Lambda/SFN) ────────────────────
  if (integrationType === "AWS" || integrationType === "AWS_PROXY") {
    const serviceMatch = uri.match(/arn:aws:apigateway:[^:]+:([^:]+):/);
    if (serviceMatch) {
      return { kind: "service", label: `aws:${serviceMatch[1]}` };
    }
    return { kind: "service", label: uri };
  }
  if (integrationType === "HTTP_PROXY" && uri.includes("vpc")) {
    return { kind: "vpc", label: uri };
  }
  return { kind: "none", label: uri };
}

function restRowFromMethod(path: string, httpMethod: string, m: RestMethod, resourceId: string): RouteRow {
  const integ = m.methodIntegration;
  const classified = classifyIntegration(
    integ?.uri,
    integ?.type,
    undefined,
    undefined,
    integ?.requestTemplates as Record<string, string> | undefined,
  );
  return {
    method: httpMethod,
    path,
    authorizationType: m.authorizationType,
    integrationKind: classified.kind,
    integrationLabel: classified.label,
    integrationTargetArn: classified.targetArn,
    invokableKind: classified.invokableKind,
    invokableTargetArn: classified.invokableTargetArn,
    resourceId,
    requestParams: parseRequestParameters(m.requestParameters),
  };
}

/**
 * Turn API Gateway's flat `requestParameters` map into three lists the Test
 * panel can render directly. Keys look like:
 *   method.request.querystring.<name>
 *   method.request.header.<name>
 *   method.request.path.<name>
 * The boolean value indicates whether the parameter is required.
 * Unknown key shapes are ignored — we surface only what we understand.
 */
function parseRequestParameters(
  raw: Record<string, boolean> | undefined,
): RouteRow["requestParams"] {
  const out = {
    querystring: [] as Array<{ name: string; required: boolean }>,
    header: [] as Array<{ name: string; required: boolean }>,
    path: [] as Array<{ name: string; required: boolean }>,
  };
  if (!raw) return out;
  for (const [key, required] of Object.entries(raw)) {
    const parts = key.split(".");
    // Expected shape: ["method", "request", <kind>, <name>...]
    if (parts.length < 4 || parts[0] !== "method" || parts[1] !== "request") continue;
    const kind = parts[2];
    const name = parts.slice(3).join("."); // preserve dots in header names
    if (kind === "querystring") out.querystring.push({ name, required: Boolean(required) });
    else if (kind === "header") out.header.push({ name, required: Boolean(required) });
    else if (kind === "path") out.path.push({ name, required: Boolean(required) });
  }
  return out;
}

function v2RowFromRoute(
  method: string,
  path: string,
  authorizationType: string | undefined,
  integ: V2Integration | undefined,
): RouteRow {
  const classified = classifyIntegration(
    integ?.IntegrationUri,
    integ?.IntegrationType,
    integ?.IntegrationSubtype,
    integ?.RequestParameters as Record<string, string> | undefined,
  );
  return {
    method,
    path,
    authorizationType: authorizationType ?? "NONE",
    integrationKind: classified.kind,
    integrationLabel: classified.label,
    integrationTargetArn: classified.targetArn,
    invokableKind: classified.invokableKind,
    invokableTargetArn: classified.invokableTargetArn,
  };
}
