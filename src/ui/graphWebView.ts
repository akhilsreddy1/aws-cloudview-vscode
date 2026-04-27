import * as vscode from "vscode";
import { toGraphEdgePayload, toGraphNodePayload, type SearchResultPayload } from "../graph/graphTypes";
import type { CloudViewPlatform } from "../core/platform";
import { ResourceDetailsPanel } from "./resourceDetailsPanel";
import type { ResourceNode } from "../core/contracts";
import { isEcsScaleActionId, scheduleEcsDiscoveryRefreshAfterMutation } from "../registry/actionRegistry";

type GraphReloadContext =
  | { kind: "single"; rootArn: string }
  | { kind: "serviceMap"; accountIds: string[]; services?: string[] }
  | { kind: "multiRoot"; arns: string[]; depth: number };

export class GraphWebView {
  private panel?: vscode.WebviewPanel;
  private currentRootArn?: string;
  /** Basis for the last full graph replace (used by Reset). Appends from double-click do not update this. */
  private lastGraphReload?: GraphReloadContext;
  private readonly detailsPanel: ResourceDetailsPanel;

  public constructor(private readonly platform: CloudViewPlatform) {
    this.detailsPanel = new ResourceDetailsPanel(platform);
  }

  public async show(rootArn?: string): Promise<void> {
    this.currentRootArn = rootArn ?? this.currentRootArn;
    this.ensurePanel();

    if (this.currentRootArn) {
      await this.renderGraph(this.currentRootArn, true);
    }
  }

  public async showServiceMap(accountIds: string[], services?: string[]): Promise<void> {
    this.ensurePanel();
    this.lastGraphReload = { kind: "serviceMap", accountIds, services };

    const graph = await this.platform.graphEngine.buildServiceMap(accountIds, services);
    const title = services?.length ? services.join(" + ") : "All Services";

    this.panel?.webview.postMessage({
      type: "replaceGraph",
      payload: {
        rootArn: graph.rootArn,
        nodes: graph.nodes.map(toGraphNodePayload),
        edges: graph.edges.map(toGraphEdgePayload),
        title: `Service Map: ${title}`,
      }
    });

    if (graph.nodes.length > 0) {
      await this.postDetails(graph.nodes[0].arn);
    }
  }

  public async showMultiRoot(arns: string[], depth?: number): Promise<void> {
    this.ensurePanel();

    const expandDepth = depth ?? this.platform.getConfig().defaultGraphExpandDepth;
    this.lastGraphReload = { kind: "multiRoot", arns, depth: expandDepth };

    const graph = await this.platform.graphEngine.expandMultiRoot(arns, expandDepth);

    this.panel?.webview.postMessage({
      type: "replaceGraph",
      payload: {
        rootArn: graph.rootArn,
        nodes: graph.nodes.map(toGraphNodePayload),
        edges: graph.edges.map(toGraphEdgePayload),
      }
    });

    if (graph.nodes.length > 0) {
      await this.postDetails(graph.nodes[0].arn);
    }
  }

  private ensurePanel(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("cloudViewGraph", "Cloud View Graph", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.platform.extensionContext.extensionUri, "media")
        ]
      });

      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      this.panel.webview.onDidReceiveMessage(async (message) => {
        await this.handleMessage(message);
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
  }

  private async handleMessage(message: { type: string; arn?: string; actionId?: string; query?: string; depth?: number }): Promise<void> {
    switch (message.type) {
      case "ready":
        if (this.currentRootArn) {
          await this.renderGraph(this.currentRootArn, true);
        }
        break;
      case "expand":
        if (message.arn) {
          await this.renderGraph(message.arn, false, message.depth);
        }
        break;
      case "reloadAtDepth":
        if (this.currentRootArn) {
          await this.renderGraph(this.currentRootArn, true, message.depth);
        } else {
          await this.reloadLastGraph(message.depth);
        }
        break;
      case "requestDetails":
        if (message.arn) {
          await this.postDetails(message.arn);
        }
        break;
      case "runAction":
        if (message.arn && message.actionId) {
          const resource = await this.platform.resourceRepo.getByArn(message.arn);
          const action = resource ? this.platform.actionRegistry.getAction(message.actionId) : undefined;
          if (resource && action) {
            await action.execute(resource, this.platform);
            if (isEcsScaleActionId(message.actionId as string)) {
              void scheduleEcsDiscoveryRefreshAfterMutation(this.platform, resource, async () => {
                await this.postDetails(resource.arn);
              });
            } else {
              await this.postDetails(resource.arn);
            }
          }
        }
        break;
      case "search":
        await this.postSearchResults(message.query ?? "");
        break;
      case "openResource":
        if (message.arn) {
          this.currentRootArn = message.arn;
          await this.renderGraph(message.arn, true);
        }
        break;
      case "resetGraph":
        await this.reloadLastGraph();
        break;
      case "copyArn":
        if (message.arn) {
          await vscode.env.clipboard.writeText(message.arn);
          void vscode.window.setStatusBarMessage("CloudView: ARN copied to clipboard", 2000);
        }
        break;
      default:
        break;
    }
  }

  private async reloadLastGraph(depthOverride?: number): Promise<void> {
    if (!this.lastGraphReload) {
      if (this.currentRootArn) {
        await this.renderGraph(this.currentRootArn, true, depthOverride);
      }
      return;
    }

    switch (this.lastGraphReload.kind) {
      case "single":
        this.currentRootArn = this.lastGraphReload.rootArn;
        await this.renderGraph(this.lastGraphReload.rootArn, true, depthOverride);
        break;
      case "serviceMap":
        await this.showServiceMap(this.lastGraphReload.accountIds, this.lastGraphReload.services);
        break;
      case "multiRoot":
        await this.showMultiRoot(this.lastGraphReload.arns, depthOverride ?? this.lastGraphReload.depth);
        break;
    }
  }

  private async renderGraph(rootArn: string, replace: boolean, depthOverride?: number): Promise<void> {
    if (replace) {
      this.lastGraphReload = { kind: "single", rootArn };
    }

    const depth = depthOverride ?? this.platform.getConfig().defaultGraphExpandDepth;
    const graph = await this.platform.graphEngine.expand(rootArn, depth);
    this.panel?.webview.postMessage({
      type: replace ? "replaceGraph" : "appendGraph",
      payload: {
        rootArn,
        nodes: graph.nodes.map(toGraphNodePayload),
        edges: graph.edges.map(toGraphEdgePayload)
      }
    });
    await this.postDetails(rootArn);
  }

  private async postDetails(arn: string): Promise<void> {
    const resource = await this.platform.resourceRepo.getByArn(arn);
    if (!resource) {
      return;
    }

    this.panel?.webview.postMessage({
      type: "details",
      payload: this.detailsPanel.build(resource)
    });
  }

  private async postSearchResults(query: string): Promise<void> {
    const resources = query.trim().length > 0 ? await this.platform.graphEngine.search(query.trim(), 25) : [];
    const results: SearchResultPayload[] = resources.map((resource) => this.toSearchResult(resource));
    this.panel?.webview.postMessage({
      type: "searchResults",
      payload: results
    });
  }

  private toSearchResult(resource: ResourceNode): SearchResultPayload {
    const definition = this.platform.resourceRegistry.get(resource.type);
    return {
      arn: resource.arn,
      label: resource.name,
      subtitle: `${definition?.displayName ?? resource.type} • ${resource.region} • ${resource.accountId}`
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (file: string): string =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.platform.extensionContext.extensionUri, "media", file))
        .toString();
    const scriptUri = asset("graphView.js");
    const styleUri = asset("graphView.css");
    const cytoscapeUri = asset("cytoscape.min.js");
    const layoutBaseUri = asset("layout-base.js");
    const coseBaseUri = asset("cose-base.js");
    const fcoseUri = asset("cytoscape-fcose.js");
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Cloud View Graph</title>
  </head>
  <body>
    <div id="app">
      <header id="toolbar">
        <div class="toolbar-row toolbar-row-main">
          <div class="title">
            <strong>AWS CloudView Graph</strong>
          </div>
          <div class="search-area">
            <input id="search-input" type="search" placeholder="Search by name, ARN, or type\u2026" autocomplete="off" />
            <select id="service-filter" title="Filter by service">
              <option value="">All Services</option>
            </select>
          </div>
          <div class="toolbar-actions">
            <button class="toolbar-btn" id="btn-fit" title="Fit graph to screen">Fit</button>
            <button class="toolbar-btn" id="btn-relayout" title="Re-run layout">Re-layout</button>
            <button class="toolbar-btn toolbar-btn-primary" id="btn-reset" title="Reload graph from cache and clear filters">Reset</button>
          </div>
        </div>
        <div class="toolbar-row toolbar-row-controls">
          <div class="control-group" title="Group nodes into regions / accounts">
            <label class="control-label" for="group-select">Group by</label>
            <select id="group-select">
              <option value="none" selected>None</option>
              <option value="region">Region</option>
              <option value="account">Account</option>
              <option value="account-region">Account \u00B7 Region</option>
            </select>
          </div>
          <div class="control-group" title="Highlight nodes in one account (combine with region or service)">
            <label class="control-label" for="account-filter">Account</label>
            <select id="account-filter">
              <option value="">All accounts</option>
            </select>
          </div>
          <div class="control-group" title="Highlight nodes in one region (combine with account or service)">
            <label class="control-label" for="region-filter">Region</label>
            <select id="region-filter">
              <option value="">All regions</option>
            </select>
          </div>
          <button type="button" class="toolbar-btn toggle-btn" id="btn-focus" title="Focus mode: isolate selected node's neighborhood (Esc to exit)">Focus: off</button>
          <span class="toolbar-hint">Right-click a node for more actions \u00B7 \u2318F to search</span>
        </div>
      </header>
      <main id="content">
        <section id="graph-pane">
          <div id="search-results"></div>
          <div id="graph"></div>
          <div id="graph-legend"></div>
          <div id="context-menu" class="context-menu" role="menu"></div>
        </section>
        <aside id="details-pane">
          <div id="details-empty">
            <h2>Select a node</h2>
            <p>Click any node to see its details. Double-click to expand neighbors. Right-click for more options.</p>
          </div>
          <div id="details"></div>
        </aside>
      </main>
      <footer id="status-bar">
        <div class="status-section status-scope" id="status-scope">\u2014</div>
        <div class="status-section status-filters" id="status-filters"></div>
        <div class="status-section status-counts" id="status-counts">0 nodes \u00B7 0 edges</div>
        <div class="status-section status-refresh" id="status-refresh">Awaiting data\u2026</div>
      </footer>
    </div>
    <script nonce="${nonce}" src="${cytoscapeUri}"></script>
    <script nonce="${nonce}" src="${layoutBaseUri}"></script>
    <script nonce="${nonce}" src="${coseBaseUri}"></script>
    <script nonce="${nonce}" src="${fcoseUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < 32; index += 1) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return result;
}
