import * as vscode from "vscode";
import type { CloudViewPlatform } from "../core/platform";
import { GLOBAL_REGION, type ResourceNode } from "../core/contracts";
import { generateNonce, escapeJsonForEmbed, escapeHtml, buildCsp, AWS_ICONS, DEFAULT_ICON, BASE_STYLES, BASE_SCRIPTS } from "../views/webviewToolkit";
import { ResourceTypes } from "../core/resourceTypes";
import { getServiceViewConfig, resolveResourceValue, type ColumnDef, type ServiceViewConfig } from "./serviceColumnConfig";
import { PANEL_ACTION_HANDLERS, type PanelActionContext } from "./panelActions";


/**
 * Injects scope columns (Region and Account) for services that don't already declare equivalents.
 */
function injectScopeColumns(columns: readonly ColumnDef[], opts: { region: boolean; account: boolean }): ColumnDef[] {
  const result = [...columns];
  let insertAt = 0;
  for (let i = 0; i < result.length; i++) {
    const k = result[i].key;
    if (k === "name" || k === "id" || k === "type" || k.startsWith("__")) {
      insertAt = i + 1;
    } else {
      break;
    }
  }
  const toInsert: ColumnDef[] = [];
  if (opts.account) toInsert.push({ key: "accountId", label: "Account", type: "code" });
  if (opts.region) toInsert.push({ key: "region", label: "Region", type: "text" });
  result.splice(insertAt, 0, ...toInsert);
  return result;
}

/**
 * ServiceDetailPanel is a panel that displays the details of a service.
 * This panel handles displaying detailed information about a specific AWS service,
 * including its resources and related actions.
 * It listens for messages from the webview and performs actions such as listing Kafka topics,
 * deleting CloudFormation stacks, executing state machines, and opening resources in the graph view.
 * The panel maintains a map of open panels to ensure that only one panel per service, account, and region combination is open at a time.
 */
export class ServiceDetailPanel {
  private static panels = new Map<string, ServiceDetailPanel>();
  private readonly panel: vscode.WebviewPanel;

  /** Arrays for multi-scope (aggregate) mode; single-element arrays for single-scope. */
  private readonly accountIds: string[];
  private readonly queryRegions: string[];
  private readonly isMultiScope: boolean;
  /**
   * Single-flight guard for this panel's "Refresh" button. Mashing the button
   * would otherwise stack multiple `withProgress` toasts and kick off parallel
   * discovery runs for the same service scope. Attach to the in-flight promise
   * instead, so repeated clicks resolve together.
   */
  private refreshInFlight: Promise<void> | undefined;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly serviceKey: string,
    private readonly config: ServiceViewConfig,
    private resources: ResourceNode[],
    accountIds: string[],
    queryRegions: string[],
  ) {
    this.accountIds = accountIds;
    this.queryRegions = queryRegions;
    this.isMultiScope = accountIds.length > 1 || queryRegions.length > 1;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewServiceDetail",
      config.serviceLabel,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    // Customziable HTML content for the webview
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => ServiceDetailPanel.panels.delete(this.serviceKey));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg);
    });
  }

  /** Single-scope open — used when clicking a specific resource node. */
  public static async open(
    platform: CloudViewPlatform,
    serviceKey: string,
    accountId: string,
    region: string
  ): Promise<void> {
    const config = getServiceViewConfig(serviceKey);
    if (!config) {
      void vscode.window.showWarningMessage(`No view configuration for service: ${serviceKey}`);
      return;
    }

    const defs = platform.resourceRegistry.getByService(config.serviceId);
    const isGlobal = defs.length > 0 && defs.every((d) => d.scope === "global");
    const queryRegion = isGlobal ? GLOBAL_REGION : region;

    const resources = await platform.resourceRepo.listByScope({
      accountId,
      region: queryRegion,
      service: config.serviceId,
    });

    const panelKey = `${serviceKey}:${accountId}:${queryRegion}`;
    const existing = ServiceDetailPanel.panels.get(panelKey);
    if (existing) {
      existing.resources = resources;
      existing.panel.webview.postMessage({
        type: "updateResources",
        resources: existing.serializeResources(resources),
        stats: existing.computeStats(resources),
      });
      existing.panel.reveal();
      return;
    }

    const instance = new ServiceDetailPanel(platform, panelKey, config, resources, [accountId], [queryRegion]);
    ServiceDetailPanel.panels.set(panelKey, instance);
  }

  /**
   * Aggregate (multi-scope) open — used when clicking a service node in the tree.
   * Shows resources across all selected accounts and regions in a single panel.
   */
  public static async openMultiScope(
    platform: CloudViewPlatform,
    serviceKey: string,
    accountIds: string[],
    regions: string[]
  ): Promise<void> {
    const config = getServiceViewConfig(serviceKey);
    if (!config) {
      void vscode.window.showWarningMessage(`No view configuration for service: ${serviceKey}`);
      return;
    }

    const defs = platform.resourceRegistry.getByService(config.serviceId);
    const isGlobal = defs.length > 0 && defs.every((d) => d.scope === "global");
    const queryRegions = isGlobal ? [GLOBAL_REGION] : regions;

    const resources = await platform.resourceRepo.listByMultiScope({
      service: config.serviceId,
      accountIds,
      regions: queryRegions,
    });

    const panelKey = `${serviceKey}:agg`;
    const existing = ServiceDetailPanel.panels.get(panelKey);
    if (existing) {
      existing.resources = resources;
      existing.panel.webview.postMessage({
        type: "updateResources",
        resources: existing.serializeResources(resources),
        stats: existing.computeStats(resources),
      });
      existing.panel.reveal();
      return;
    }

    const instance = new ServiceDetailPanel(platform, panelKey, config, resources, accountIds, queryRegions);
    ServiceDetailPanel.panels.set(panelKey, instance);
  }

  /**
   * Handles messages from the webview.
   * @param msg - The message from the webview.
   * @returns A promise that resolves when the message is handled.
   * Ex: { type: "deleteCfnStack", arn: "arn:aws:cloudformation:region:account:stack/stack-name/stack-id", retainResources: ["LogicalResourceId1", "LogicalResourceId2"] }
   * Ex: { type: "ec2StartStop", arn: "arn:aws:ec2:region:account:instance/instance-id" }
   */
  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    /** Force refresh the resources from AWS for this dashboard scope. */
    if (type === "refresh") {
      await this.refreshDashboardFromAws();
      return;
    }

    // Dispatch to registered panel action handlers ; so if the user clicks on the "Delete CloudFormation Stack" button, the deleteCfnStack handler will be called.
    const handler = PANEL_ACTION_HANDLERS[type];
    if (handler) {
      await handler(msg, this.buildActionContext());
    }
  }

  /**
   * Runs AWS discovery for {@link ServiceDetailPanel.config.serviceId} only, for every
   * account/region pair this panel was opened with, then reloads rows from SQLite.
   */
  private async refreshDashboardFromAws(): Promise<void> {
    if (this.refreshInFlight) {
      void vscode.window.setStatusBarMessage(`${this.config.serviceLabel} refresh already in progress ,please wait...\u2026`, 2500);
      return this.refreshInFlight; // Return the existing refresh promise to avoid creating a new one.
    }

    const serviceId = this.config.serviceId;
    const label = this.config.serviceLabel;

    this.refreshInFlight = (async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing ${label} resources from AWS...`,
            cancellable: false,
          },
          async () => {
            const failures: string[] = [];
            for (const accountId of this.accountIds) {
              for (const region of this.queryRegions) {
                const profileName = await this.platform.sessionManager.findProfileNameByAccountId(accountId);
                if (!profileName) {
                  failures.push(`${accountId}/${region} (no profile for account)`);
                  continue;
                }
                const scope = { profileName, accountId, region };
                try {
                  await this.platform.discoveryCoordinator.refreshServiceScope(scope, serviceId, { force: true });
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : String(err);
                  failures.push(`${accountId}/${region}: ${message}`);
                  this.platform.logger.warn(
                    `Service dashboard refresh failed for ${serviceId} at ${accountId}/${region}: ${message}`
                  );
                }
              }
            }
            await this.reloadPanelFromRepo();
            if (failures.length > 0) {
              void vscode.window.showWarningMessage(
                `${label}: refresh incomplete (${failures.length} scope(s)). Check the Cloud View output for details.`
              );
            } else {
              void vscode.window.setStatusBarMessage(`${label} refreshed from AWS`, 2500);
            }
          }
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Refresh failed: ${message}`);
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }

  private async reloadPanelFromRepo(): Promise<void> {
    const refreshed = this.isMultiScope
      ? await this.platform.resourceRepo.listByMultiScope({
          service: this.config.serviceId,
          accountIds: this.accountIds,
          regions: this.queryRegions,
        })
      : await this.platform.resourceRepo.listByScope({
          accountId: this.accountIds[0],
          region: this.queryRegions[0],
          service: this.config.serviceId,
        });
    this.resources = refreshed;
    await this.panel.webview.postMessage({
      type: "updateResources",
      resources: this.serializeResources(refreshed),
      stats: this.computeStats(refreshed),
    });
  }

  private buildActionContext(): PanelActionContext {
    return {
      platform: this.platform,
      serviceId: this.config.serviceId,
      accountIds: this.accountIds,
      queryRegions: this.queryRegions,
      isMultiScope: this.isMultiScope,
      postMessage: (m) => this.panel.webview.postMessage(m),
      refreshPanel: async () => {
        await this.reloadPanelFromRepo();
      },
    };
  }

  private serializeResources(resources: ResourceNode[]): unknown[] {
    return resources.map((r) => {
      const row: Record<string, unknown> = {
        arn: r.arn,
        name: r.name || r.id,
        id: r.id,
        type: r.type.split(".").pop() ?? r.type,
        region: r.region,
        accountId: r.accountId,
        tags: r.tags,
        resourceType: r.type,
      };
      for (const col of this.config.columns) {
        if (!["name", "id", "type"].includes(col.key)) {
          row[col.key] = resolveResourceValue(r, col.key);
        }
      }
      row._rawJson = r.rawJson;
      row._tags = r.tags;
      row.cvActionIds = this.platform.actionRegistry.getActionsForResource(r, this.platform).map((a) => a.id);
      return row;
    });
  }

  private computeStats(resources: ResourceNode[]): Array<{ label: string; value: string | number; color: string }> {
    return this.config.stats.map((s) => ({
      label: s.label,
      value: s.compute(resources),
      color: s.color,
    }));
  }

  private buildHtml(): string {
    const nonce = generateNonce();
    const icon = AWS_ICONS[this.config.iconKey] || DEFAULT_ICON;
    const serialized = escapeJsonForEmbed(this.serializeResources(this.resources));
    const stats = escapeJsonForEmbed(this.computeStats(this.resources));

    // Auto-inject "Region" and "Account" columns for services that don't already
    // declare equivalents. S3 already has its own `BucketRegion` (label "Region"),
    // so we skip the region injection for it but still add Account. Each tab's
    // `columns` whitelist is patched in lockstep so the new columns appear on
    // every filtered tab too.
    const hasRegionColumn = this.config.columns.some(
      (c) => c.key === "region" || c.label === "Region"
    );
    const hasAccountColumn = this.config.columns.some(
      (c) => c.key === "accountId" || c.label === "Account"
    );
    const needsInject = !hasRegionColumn || !hasAccountColumn;
    const effectiveColumns = needsInject
      ? injectScopeColumns(this.config.columns, { region: !hasRegionColumn, account: !hasAccountColumn })
      : this.config.columns;
    const effectiveTabs = (this.config.tabs ?? [{ id: "all", label: "All" }]).map((tab) => {
      if (!needsInject || !tab.columns || tab.columns.length === 0) return tab;
      const cols = [...tab.columns];
      if (!hasRegionColumn && !cols.includes("region")) cols.push("region");
      if (!hasAccountColumn && !cols.includes("accountId")) cols.push("accountId");
      return { ...tab, columns: cols };
    });

    const columns = escapeJsonForEmbed(effectiveColumns);
    const tabs = escapeJsonForEmbed(effectiveTabs);
    const dummyResource: ResourceNode = {
      arn: "", id: "", type: "", service: "", accountId: "", region: "", name: "", tags: {}, rawJson: {}, lastUpdated: 0,
    };

    // Compute union of actions across all distinct resource types in the panel.
    // Track which types each action applies to so the sidebar can filter per-row.
    // This is necessary to ensure that each action knows which resource types it can be applied to 
    // based on previously registered actions for each resource type.

    // Union actions across every row so stateful actions (e.g. RDS Start vs Stop) are not dropped
    // when the first row of a type is in the “wrong” state. Per-row visibility uses cvActionIds + drawerActionVisible.
    const actionMap = new Map<string, { id: string; title: string; types: string[] }>();
    for (const r of this.resources) {
      for (const a of this.platform.actionRegistry.getActionsForResource(r, this.platform)) {
        const entry = actionMap.get(a.id);
        if (!entry) {
          actionMap.set(a.id, { id: a.id, title: a.title, types: [r.type] });
        } else if (!entry.types.includes(r.type)) {
          entry.types.push(r.type);
        }
      }
    }
    if (this.config.serviceId === "rds") {
      const rdsMutation: Array<{ id: string; types: string[] }> = [
        { id: "cloudView.rds.stopCluster", types: [ResourceTypes.rdsCluster] },
        { id: "cloudView.rds.startCluster", types: [ResourceTypes.rdsCluster] },
        { id: "cloudView.rds.stopInstance", types: [ResourceTypes.rdsInstance] },
        { id: "cloudView.rds.startInstance", types: [ResourceTypes.rdsInstance] },
      ];
      for (const { id, types } of rdsMutation) {
        const act = this.platform.actionRegistry.getAction(id);
        if (act && !actionMap.has(id)) {
          actionMap.set(id, { id: act.id, title: act.title, types });
        }
      }
    }
    if (this.config.serviceId === "ecs") {
      for (const id of ["cloudView.ecs.scaleToZero", "cloudView.ecs.scaleFromZero"] as const) {
        const act = this.platform.actionRegistry.getAction(id);
        if (act && !actionMap.has(id)) {
          actionMap.set(id, { id: act.id, title: act.title, types: [ResourceTypes.ecsService] });
        }
      }
    }
    // If no actions were found for the existing resources, fall back to the dummy resource to ensure there is at least a baseline set of actions.
    if (actionMap.size === 0) {
      for (const a of this.platform.actionRegistry.getActionsForResource(dummyResource, this.platform)) {
        actionMap.set(a.id, { id: a.id, title: a.title, types: [] });
      }
    }
    const actions = escapeJsonForEmbed([...actionMap.values()]);
    const hasLogs = this.config.serviceId === "lambda" || this.config.serviceId === "ecs";
    const isMsk = this.config.serviceId === "msk";
    const isRds = this.config.serviceId === "rds";
    const isEcs = this.config.serviceId === "ecs";
    const isVpc = this.config.serviceId === "vpc";
    const isCfn = this.config.serviceId === "cloudformation";
    const isSfn = this.config.serviceId === "stepfunctions";
    const serviceId = this.config.serviceId;
    const csvFilename = escapeHtml(this.config.serviceLabel).replace(/\s+/g, "_");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(nonce)}">
  <title>${escapeHtml(this.config.serviceLabel)}</title>
  <style>${BASE_STYLES}
    .cv-table tbody tr.cv-row-cluster { font-weight: 600; background: #f8fafc; }
    .cv-table tbody tr.cv-row-cluster td:first-child::before { content: "\\25B6  "; opacity: 0.45; font-size: 10px; }
    .cv-table tbody tr.cv-row-child td:first-child { padding-left: 28px; }
    .cv-table tbody tr.cv-row-child td:first-child::before { content: "\\2514  "; opacity: 0.35; font-size: 10px; margin-right: 4px; }
    .cv-table tbody tr.cv-row-standalone-hdr td { background: #fff7ed; font-weight: 600; font-size: 11px; color: var(--muted); }
    .cv-table tbody tr.cv-row-deleting { background: #fef2f2; }
    .cv-table tbody tr.cv-row-deleting td { color: #b91c1c; }
    .cv-table tbody tr.cv-row-deleting.selected { background: #fee2e2; }
    #msk-topics-list table th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); }
    #msk-topics-list table td { padding: 3px 6px; border-bottom: 1px solid #f4f6f9; }
    .cv-topics-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid #C7131F; color: #C7131F; background: transparent; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }
    .cv-topics-btn:hover { background: #fef2f2; }
    .cv-cfn-delete-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid #b91c1c; color: #b91c1c; background: transparent; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; }
    .cv-cfn-delete-btn:hover { background: #fef2f2; }
    .cv-danger-btn { border-color: #b91c1c !important; color: #b91c1c !important; }
    .cv-danger-btn:hover { background: #fef2f2 !important; }
    .cv-invoke-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border: 1px solid #FF9900; color: #FF9900; background: transparent; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600; }
    .cv-invoke-btn:hover { background: #fff7ed; }
    .cv-logs-browse-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border: 1px solid #C925D1; color: #C925D1; background: transparent; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600; }
    .cv-logs-browse-btn:hover { background: #fdf4ff; }
    .cv-execute-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border: 1px solid #C925D1; color: #C925D1; background: transparent; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600; }
    .cv-execute-btn:hover { background: #fdf4ff; }
    .cv-table-ecs-scale {
      display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid; border-radius: 4px;
      font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; background: transparent; white-space: nowrap;
    }
    .cv-table-ecs-scale.cv-ecs-scale-in { border-color: #b91c1c; color: #b91c1c; }
    .cv-table-ecs-scale.cv-ecs-scale-in:hover { background: #fef2f2; }
    .cv-table-ecs-scale.cv-ecs-scale-out { border-color: #15803d; color: #15803d; }
    .cv-table-ecs-scale.cv-ecs-scale-out:hover { background: #f0fdf4; }
    .cv-ecs-scale-na { color: var(--vscode-descriptionForeground, var(--muted, #888)); font-size: 11px; }
    .cv-table-ec2-startstop {
      border: 1px solid; background: transparent; padding: 3px 10px; border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 600; cursor: pointer; transition: background .15s;
    }
    .cv-table-ec2-startstop.cv-ec2-stop { border-color: #b91c1c; color: #b91c1c; }
    .cv-table-ec2-startstop.cv-ec2-stop:hover { background: #fef2f2; }
    .cv-table-ec2-startstop.cv-ec2-start { border-color: #15803d; color: #15803d; }
    .cv-table-ec2-startstop.cv-ec2-start:hover { background: #f0fdf4; }
    .cv-table-rds-startstop {
      border: 1px solid; background: transparent; padding: 3px 10px; border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 600; cursor: pointer; transition: background .15s;
    }
    .cv-table-rds-startstop.cv-rds-stop { border-color: #b91c1c; color: #b91c1c; }
    .cv-table-rds-startstop.cv-rds-stop:hover { background: #fef2f2; }
    .cv-table-rds-startstop.cv-rds-start { border-color: #15803d; color: #15803d; }
    .cv-table-rds-startstop.cv-rds-start:hover { background: #f0fdf4; }
  </style>
</head>
<body>
  <div class="cv-header">
    <div class="cv-header-top">
      <div class="cv-service-icon">${icon}</div>
      <div class="cv-title-group">
        <div class="cv-service-title">${escapeHtml(this.config.serviceLabel)}</div>
        <div class="cv-service-subtitle">
          <span>${escapeHtml(this.accountIds.length > 1 ? this.accountIds.length + " accounts" : this.accountIds[0] || "account")}</span>
          <span class="cv-sep">\u2022</span>
          <span>${escapeHtml(this.queryRegions.length > 1 ? this.queryRegions.length + " regions" : this.queryRegions[0] || "region")}</span>
          <span class="cv-sep">\u2022</span>
          <span id="cv-meta">\u2014</span>
        </div>
      </div>
      <div class="cv-header-actions">
        <button class="cv-btn" id="cv-service-graph" title="Service Graph" style="border-color:#8C4FFF;color:#8C4FFF;">&#x1F517; Graph</button>
        <button class="cv-btn" id="cv-refresh" title="Re-discover this service from AWS and reload the table (R)">&#8635; Refresh</button>
      </div>
    </div>
    <div class="cv-stats" id="cv-stats"></div>
  </div>
  <div class="cv-tabs" id="cv-tabs"></div>
  <div class="cv-toolbar">
    <div class="cv-search-wrap">
      <input class="cv-search" id="cv-filter" type="text" placeholder="Filter resources\u2026" autofocus>
      <span class="cv-kbd cv-search-kbd">\u2318F</span>
    </div>
    <span class="cv-count" id="cv-count"></span>
    <div class="cv-toolbar-spacer"></div>
    <div class="cv-chip-group" id="cv-chips"></div>
    <button class="cv-btn cv-export" id="cv-export">&#8681; CSV</button>
  </div>
  <div class="cv-table-wrap">
    <table class="cv-table" id="cv-table">
      <thead><tr id="cv-thead"></tr></thead>
      <tbody id="cv-tbody"></tbody>
    </table>
  </div>

  <div id="cv-overlay"></div>
  <div class="cv-drawer" id="cv-drawer">
    <div class="cv-drawer-header">
      <div style="flex:1;min-width:0;">
        <div class="cv-drawer-name" id="cv-drawer-name"></div>
        <div class="cv-drawer-arn" id="cv-drawer-arn"></div>
      </div>
      <button class="cv-btn" id="cv-drawer-copy-arn" title="Copy ARN" style="padding:4px 8px;font-size:11px;">Copy ARN</button>
      <button class="cv-drawer-close" id="cv-drawer-close" title="Close (Esc)">&times;</button>
    </div>
    <div class="cv-drawer-body" id="cv-drawer-body"></div>
  </div>

  <script nonce="${nonce}">
    ${BASE_SCRIPTS}

    var vscode = acquireVsCodeApi();
    var ALL_RESOURCES = ${serialized};
    var STATS = ${stats};
    var COLUMNS = ${columns};
    var TABS = ${tabs};
    var ACTIONS = ${actions};
    var HAS_LOGS = ${hasLogs};
    var IS_MSK = ${isMsk};
    var IS_RDS = ${isRds};
    var IS_ECS = ${isEcs};
    var IS_VPC = ${isVpc};
    var IS_CFN = ${isCfn};
    var IS_SFN = ${isSfn};
    var SERVICE_ID = ${JSON.stringify(serviceId)};
    var activeTab = TABS.length > 0 ? TABS[0].id : 'all';
    var sortCol = 0;
    var sortAsc = true;
    var filterText = '';
    var selectedArn = null;

    function renderStats() {
      var el = document.getElementById('cv-stats');
      el.innerHTML = STATS.map(function(s) {
        return '<div class="cv-stat-card" style="--stat-accent:' + s.color + '">' +
          '<div class="cv-stat-value">' + escHtml(String(s.value)) + '</div>' +
          '<div class="cv-stat-label">' + escHtml(s.label) + '</div></div>';
      }).join('');
      var n = ALL_RESOURCES.length;
      document.getElementById('cv-meta').textContent = n + ' resource' + (n === 1 ? '' : 's');
    }

    // Quick status filter chips — sits next to search
    var activeChip = null;
    function renderChips() {
      var el = document.getElementById('cv-chips');
      if (!el) { return; }
      el.innerHTML = '';
      var filtered = getFilteredByTab(activeTab);
      var counts = {};
      filtered.forEach(function(r) {
        var st = String(getVal(r, 'State.Name') || getVal(r, 'State') || getVal(r, 'DBInstanceStatus') || getVal(r, 'ClusterStatus') || getVal(r, 'TableStatus') || '').toLowerCase();
        if (st) { counts[st] = (counts[st] || 0) + 1; }
      });
      var states = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; });
      if (states.length <= 1) { return; }
      states.slice(0, 4).forEach(function(st) {
        var c = document.createElement('div');
        c.className = 'cv-chip' + (activeChip === st ? ' active' : '');
        c.textContent = st + ' \u00B7 ' + counts[st];
        c.onclick = function() {
          activeChip = activeChip === st ? null : st;
          renderChips(); renderTable();
        };
        el.appendChild(c);
      });
    }

    function renderTabs() {
      var el = document.getElementById('cv-tabs');
      if (TABS.length <= 1) { el.style.display = 'none'; return; }
      el.innerHTML = TABS.map(function(tab) {
        var count = tab.id === 'all' ? ALL_RESOURCES.length : getFilteredByTab(tab.id).length;
        var cls = tab.id === activeTab ? 'cv-tab active' : 'cv-tab';
        return '<div class="' + cls + '" data-tab="' + tab.id + '">' + escHtml(tab.label) +
          ' <span class="cv-tab-count">' + count + '</span></div>';
      }).join('');
      el.querySelectorAll('.cv-tab').forEach(function(t) {
        t.onclick = function() {
          activeTab = t.dataset.tab;
          activeChip = null;
          renderTabs();
          renderChips();
          renderTable();
        };
      });
    }

    function getFilteredByTab(tabId) {
      if (tabId === 'all') return ALL_RESOURCES;
      var tab = TABS.find(function(t) { return t.id === tabId; });
      if (!tab) return ALL_RESOURCES;
      return ALL_RESOURCES.filter(function(r) {
        var rt = r.resourceType || '';
        var state = String(getVal(r, 'State.Name') || getVal(r, 'State') || '').toLowerCase();
        var runtime = String(getVal(r, 'Runtime') || '').toLowerCase();
        var billing = String(getVal(r, 'BillingModeSummary.BillingMode') || '').toUpperCase();
        var tagMut = String(getVal(r, 'imageTagMutability') || '').toUpperCase();
        var scanPush = getVal(r, 'imageScanningConfiguration.scanOnPush');
        switch (tabId) {
          // EC2
          case 'running': return rt === 'aws.ec2.instance' && state === 'running';
          case 'stopped': return rt === 'aws.ec2.instance' && state === 'stopped';
          case 'ec2_instances': return rt === 'aws.ec2.instance';
          case 'ec2_old_gen': return rt === 'aws.ec2.instance' && getVal(r, 'IsOldGeneration') === true;
          case 'ec2_lbs': return rt === 'aws.elbv2.load-balancer';
          case 'ec2_tgs': return rt === 'aws.elbv2.target-group';
          // Lambda
          case 'active': return state === 'active';
          case 'inactive': return state === 'inactive';
          case 'deprecated_rt': return getVal(r, 'IsDeprecatedRuntime') === true;
          case 'nodejs': return runtime.indexOf('nodejs') === 0;
          case 'python': return runtime.indexOf('python') === 0;
          case 'java': return runtime.indexOf('java') === 0 && runtime.indexOf('javascript') !== 0;
          case 'other_runtime': return runtime && runtime.indexOf('nodejs') !== 0 && runtime.indexOf('python') !== 0 && runtime.indexOf('java') !== 0;
          // S3
          case 's3_unencrypted': return getVal(r, 'IsEncrypted') !== true;
          case 's3_no_versioning': return getVal(r, 'VersioningEnabled') !== true;
          case 's3_public_possible': return getVal(r, 'PublicAccessBlocked') !== true;
          // ECS
          case 'ecs_clusters': return rt === 'aws.ecs.cluster';
          case 'ecs_services': return rt === 'aws.ecs.service';
          case 'ecs_tasks': return rt === 'aws.ecs.task';
          case 'ecs_healthy': return rt === 'aws.ecs.task' && getVal(r, 'HealthStatus') === 'HEALTHY';
          case 'ecs_unhealthy': return rt === 'aws.ecs.task' && getVal(r, 'HealthStatus') === 'UNHEALTHY';
          // VPC
          case 'vpc_hierarchy': return rt === 'aws.ec2.vpc' || rt === 'aws.ec2.subnet';
          case 'vpcs': return rt === 'aws.ec2.vpc';
          case 'subnets': return rt === 'aws.ec2.subnet';
          case 'vpc_endpoints': return rt === 'aws.ec2.vpc-endpoint';
          case 'sgs': return rt === 'aws.ec2.security-group';
          case 'lattice_networks': return rt === 'aws.vpc-lattice.service-network';
          case 'lattice_services': return rt === 'aws.vpc-lattice.service';
          // EventBridge
          case 'buses': return rt.indexOf('bus') !== -1;
          case 'rules': return rt.indexOf('rule') !== -1;
          case 'enabled': return rt.indexOf('rule') !== -1 && state === 'enabled';
          case 'disabled': return rt.indexOf('rule') !== -1 && state === 'disabled';
          // DynamoDB
          case 'on_demand': return billing.indexOf('PAY_PER_REQUEST') !== -1;
          case 'provisioned': return billing.indexOf('PAY_PER_REQUEST') === -1;
          // ECR
          case 'scan_enabled': return scanPush === true;
          case 'mutable': return tagMut === 'MUTABLE';
          case 'immutable': return tagMut === 'IMMUTABLE';
          // RDS
          case 'rds_clusters': return rt === 'aws.rds.cluster';
          case 'rds_instances': return rt === 'aws.rds.instance';
          case 'rds_public': return rt === 'aws.rds.instance' && getVal(r, 'PubliclyAccessible') === true;
          case 'rds_pending': return rt === 'aws.rds.instance' && getVal(r, 'HasPendingMaintenance') === true;
          case 'rds_snapshots': return rt === 'aws.rds.snapshot';
          case 'rds_cluster_snapshots': return rt === 'aws.rds.cluster-snapshot';
          case 'rds_automated': return rt === 'aws.rds.snapshot' && String(getVal(r, 'SnapshotType') || '').toLowerCase() === 'automated';
          case 'rds_hierarchy': return rt === 'aws.rds.cluster' || rt === 'aws.rds.instance';
          // MSK
          case 'msk_active': return state === 'active';
          case 'msk_provisioned': return String(getVal(r, 'ClusterType') || '').toUpperCase() === 'PROVISIONED';
          case 'msk_serverless': return getVal(r, 'IsServerless') === true || String(getVal(r, 'ClusterType') || '').toUpperCase() === 'SERVERLESS';
          // CloudFormation
          case 'cfn_active': var cs = String(getVal(r, 'StackStatus') || ''); return cs.indexOf('_COMPLETE') !== -1 && cs.indexOf('DELETE') === -1 && cs.indexOf('ROLLBACK') === -1;
          case 'cfn_in_progress': return String(getVal(r, 'StackStatus') || '').indexOf('IN_PROGRESS') !== -1;
          case 'cfn_failed': var fs = String(getVal(r, 'StackStatus') || ''); return fs.indexOf('FAILED') !== -1 || fs.indexOf('ROLLBACK') !== -1;
          case 'cfn_drifted': return getVal(r, 'IsDriftDetected') === true;
          case 'cfn_nested': return getVal(r, 'IsNestedStack') === true;
          case 'cfn_protected': return getVal(r, 'EnableTerminationProtection') === true;
          default: return true;
        }
      });
    }

    function getVal(resource, key) {
      if (key === '__ecsScale') {
        if (resource.resourceType !== 'aws.ecs.service') return '';
        var rj = resource._rawJson || {};
        var des = rj.desiredCount != null ? Number(rj.desiredCount) : Number(resource.desiredCount);
        return isNaN(des) ? '' : String(des);
      }
      if (key === 'name') return resource.name || resource.id || '';
      if (key === 'id') return resource.id;
      if (key === 'type') return resource.type;
      if (Object.prototype.hasOwnProperty.call(resource, key)) {
        var direct = resource[key];
        if (direct !== undefined && direct !== null && direct !== '') return direct;
      }
      var parts = key.split('.');
      var cur = resource;
      for (var i = 0; i < parts.length; i++) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[parts[i]];
        if (cur === undefined && i === 0) {
          cur = resource._rawJson;
          if (cur) cur = cur[parts[i]];
        }
      }
      return cur;
    }

    // Columns visible for the current tab — tabs can declare a columns[] whitelist
    function visibleColumnsForTab(tabId) {
      var tab = TABS.find(function(t) { return t.id === tabId; });
      if (tab && tab.columns && tab.columns.length > 0) {
        var allowed = tab.columns;
        return COLUMNS.filter(function(c) { return allowed.indexOf(c.key) !== -1; });
      }
      if (SERVICE_ID === 'rds' && tabId === 'rds_hierarchy') {
        return COLUMNS.filter(function(c) { return c.key !== 'type' && c.key !== 'DBClusterIdentifier'; });
      }
      return COLUMNS;
    }

    function renderTableHead(cols) {
      cols = cols || COLUMNS;
      var thead = document.getElementById('cv-thead');
      thead.innerHTML = cols.map(function(c, i) {
        var cls = i === sortCol ? ' class="sorted"' : '';
        var arrow = i === sortCol ? (sortAsc ? ' \\u25B2' : ' \\u25BC') : '';
        return '<th' + cls + ' data-idx="' + i + '">' + escHtml(c.label) + '<span class="sort-arrow">' + arrow + '</span></th>';
      }).join('');
      thead.querySelectorAll('th').forEach(function(th) {
        th.onclick = function() {
          var idx = parseInt(th.dataset.idx);
          if (idx === sortCol) { sortAsc = !sortAsc; } else { sortCol = idx; sortAsc = true; }
          renderTable();
        };
      });
    }

    function renderColumnCell(r, col) {
      if (SERVICE_ID === 'ecs' && col.key === '__ecsScale') {
        if (r.resourceType !== 'aws.ecs.service') {
          return '<span class="cv-ecs-scale-na">\\u2014</span>';
        }
        var raw = r._rawJson || {};
        var des2 = raw.desiredCount != null ? Number(raw.desiredCount) : Number(r.desiredCount);
        if (isNaN(des2)) {
          return '<span class="cv-ecs-scale-na">\\u2014</span>';
        }
        if (des2 > 0) {
          return '<button type="button" class="cv-table-ecs-scale cv-ecs-scale-in" data-cv-action="cloudView.ecs.scaleToZero" data-arn="' + escHtml(r.arn || '') + '">Scale in</button>';
        }
        return '<button type="button" class="cv-table-ecs-scale cv-ecs-scale-out" data-cv-action="cloudView.ecs.scaleFromZero" data-arn="' + escHtml(r.arn || '') + '">Scale out</button>';
      }
      if (SERVICE_ID === 'ec2' && col.key === '__ec2StartStop') {
        if (r.resourceType !== 'aws.ec2.instance') {
          return '<span class="cv-ecs-scale-na">\\u2014</span>';
        }
        var rawEc2 = r._rawJson || {};
        var stateName = (rawEc2.State && rawEc2.State.Name ? String(rawEc2.State.Name) : '').toLowerCase();
        if (stateName === 'running') {
          return '<button type="button" class="cv-table-ec2-startstop cv-ec2-stop" data-cv-action="cloudView.ec2.stop" data-arn="' + escHtml(r.arn || '') + '">\\u23F9 Stop</button>';
        }
        if (stateName === 'stopped') {
          return '<button type="button" class="cv-table-ec2-startstop cv-ec2-start" data-cv-action="cloudView.ec2.start" data-arn="' + escHtml(r.arn || '') + '">\\u25B6 Start</button>';
        }
        // Transitional states (pending, stopping, shutting-down) and terminal (terminated): no action available.
        return '<span class="cv-ecs-scale-na" title="State: ' + escHtml(stateName) + '">\\u2014</span>';
      }
      if (SERVICE_ID === 'rds' && col.key === '__rdsStartStop') {
        var rt = r.resourceType || '';
        var rawRds = r._rawJson || {};
        if (rt === 'aws.rds.cluster') {
          var cs = String(rawRds.Status || rawRds.ClusterStatus || '').toLowerCase();
          if (cs === 'available' || cs === 'backing-up') {
            return '<button type="button" class="cv-table-rds-startstop cv-rds-stop" data-cv-action="cloudView.rds.stopCluster" data-arn="' + escHtml(r.arn || '') + '">\\u23F9 Stop</button>';
          }
          if (cs === 'stopped') {
            return '<button type="button" class="cv-table-rds-startstop cv-rds-start" data-cv-action="cloudView.rds.startCluster" data-arn="' + escHtml(r.arn || '') + '">\\u25B6 Start</button>';
          }
          return '<span class="cv-ecs-scale-na" title="Status: ' + escHtml(cs) + '">\\u2014</span>';
        }
        if (rt === 'aws.rds.instance') {
          // Aurora cluster members are managed via the cluster, not individually.
          var inCluster = rawRds.DBClusterIdentifier && String(rawRds.DBClusterIdentifier).length > 0;
          if (inCluster) {
            return '<span class="cv-ecs-scale-na" title="Aurora cluster member \\u2014 stop the cluster">\\u2014</span>';
          }
          var is = String(rawRds.DBInstanceStatus || '').toLowerCase();
          if (is === 'available' || is === 'storage-optimization') {
            return '<button type="button" class="cv-table-rds-startstop cv-rds-stop" data-cv-action="cloudView.rds.stopInstance" data-arn="' + escHtml(r.arn || '') + '">\\u23F9 Stop</button>';
          }
          if (is === 'stopped') {
            return '<button type="button" class="cv-table-rds-startstop cv-rds-start" data-cv-action="cloudView.rds.startInstance" data-arn="' + escHtml(r.arn || '') + '">\\u25B6 Start</button>';
          }
          return '<span class="cv-ecs-scale-na" title="Status: ' + escHtml(is) + '">\\u2014</span>';
        }
        return '<span class="cv-ecs-scale-na">\\u2014</span>';
      }
      // Data-driven action button registry: each entry maps a column key to button config.
      // 'attr' is the data-attribute name, 'msgType' is the postMessage type,
      // 'arnKey' is the camelCase dataset key for reading back.
      var COLUMN_BUTTONS = [
        { key: '__mskTopics', service: 'msk', cls: 'cv-topics-btn', attr: 'data-topics-arn', label: 'View Topics \\u2192', resourceType: 'aws.msk.cluster', special: true },
        { key: '__lambdaInvoke', service: 'lambda', cls: 'cv-invoke-btn', attr: 'data-invoke-arn', label: '\\u25B6 Invoke', msgType: 'invokeLambda', arnKey: 'invokeArn' },
        { key: '__sfnExecute', service: 'stepfunctions', cls: 'cv-execute-btn', attr: 'data-execute-arn', label: '\\u25B6 Execute', msgType: 'executeStateMachine', arnKey: 'executeArn' },
        { key: '__logsBrowse', service: 'logs', cls: 'cv-logs-browse-btn', attr: 'data-logs-browse-arn', label: '\\u{1F4CB} Browse \\u2192', msgType: 'logsBrowseStreams', arnKey: 'logsBrowseArn' },
        { key: '__ecrImages', service: 'ecr', cls: 'cv-invoke-btn', attr: 'data-ecr-images-arn', label: '\\u{1F4E6} View Images', msgType: 'viewEcrImages', arnKey: 'ecrImagesArn' },
        { key: '__s3Browse', service: 's3', cls: 'cv-invoke-btn', attr: 'data-s3-browse-arn', label: '\\u{1F4C2} Browse & Upload', msgType: 's3BrowsePrefixes', arnKey: 's3BrowseArn' },
        { key: '__cfnDelete', service: 'cloudformation', cls: 'cv-danger-btn cv-cfn-delete-btn', attr: 'data-cfn-delete-arn', label: '\\u{1F5D1} Delete', msgType: 'deleteCfnStack', arnKey: 'cfnDeleteArn' },
        { key: '__sqsViewMessages', service: 'sqs', cls: 'cv-invoke-btn', attr: 'data-sqs-view-arn', label: '\\u{1F4EC} View / Redrive', msgType: 'sqsViewMessages', arnKey: 'sqsViewArn' },
        { key: '__dynamodbPeek', service: 'dynamodb', cls: 'cv-invoke-btn', attr: 'data-ddb-peek-arn', label: '\\u{1F50D} Peek Items', msgType: 'dynamodbPeekItems', arnKey: 'ddbPeekArn' },
        { key: '__cfnTemplate', service: 'cloudformation', cls: 'cv-invoke-btn', attr: 'data-cfn-tpl-arn', label: '\\u{1F4DC} View Template', msgType: 'cfnViewTemplate', arnKey: 'cfnTplArn' },
      ];
      for (var i = 0; i < COLUMN_BUTTONS.length; i++) {
        var b = COLUMN_BUTTONS[i];
        if (col.key === b.key && SERVICE_ID === b.service) {
          if (b.resourceType && r.resourceType && r.resourceType !== b.resourceType) return '';
          return '<button type="button" class="' + b.cls + '" ' + b.attr + '="' + escHtml(r.arn || '') + '">' + b.label + '</button>';
        }
      }
      return renderCell({
        name: r.name,
        id: r.id,
        state: getVal(r, 'State.Name') || getVal(r, 'State') || getVal(r, 'DBInstanceStatus') || getVal(r, 'TableStatus') || getVal(r, 'ClusterStatus') || getVal(r, 'StackStatus'),
        metadata: r,
      }, col);
    }

    function cfnRowClass(r) {
      if (!IS_CFN) return '';
      var s = String(getVal(r, 'StackStatus') || '').toUpperCase();
      return s.indexOf('DELETE') !== -1 ? ' cv-row-deleting' : '';
    }

    function bindRowClicks(rowResources) {
      document.getElementById('cv-tbody').querySelectorAll('tr[data-arn]').forEach(function(tr) {
        tr.onclick = function() {
          selectedArn = tr.dataset.arn;
          var found = rowResources.find(function(r) { return r.arn === selectedArn; });
          openDrawer(found);
          renderTable();
        };
      });
    }

    function renderRdsHierarchyTable(filtered) {
      document.getElementById('cv-count').textContent = filtered.length + ' of ' + ALL_RESOURCES.length;
      var cols = visibleColumnsForTab('rds_hierarchy');
      renderTableHead(cols);
      var clusters = filtered.filter(function(r) { return r.resourceType === 'aws.rds.cluster'; });
      var instances = filtered.filter(function(r) { return r.resourceType === 'aws.rds.instance'; });
      var byCluster = {};
      clusters.forEach(function(c) { byCluster[c.id] = { cluster: c, instances: [] }; });
      var standalone = [];
      instances.forEach(function(inst) {
        var cid = getVal(inst, 'DBClusterIdentifier');
        if (cid && byCluster[cid]) {
          byCluster[cid].instances.push(inst);
        } else {
          standalone.push(inst);
        }
      });
      clusters.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
      standalone.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });

      var rowHtml = [];
      var rowResources = [];
      clusters.forEach(function(c) {
        var cls = c.arn === selectedArn ? 'selected cv-row-cluster' : 'cv-row-cluster';
        rowHtml.push('<tr data-arn="' + escHtml(c.arn || '') + '" class="' + cls + '">' +
          cols.map(function(col) { return '<td>' + renderColumnCell(c, col) + '</td>'; }).join('') +
          '</tr>');
        rowResources.push(c);
        byCluster[c.id].instances.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
        byCluster[c.id].instances.forEach(function(inst) {
          var icls = inst.arn === selectedArn ? 'selected cv-row-child' : 'cv-row-child';
          rowHtml.push('<tr data-arn="' + escHtml(inst.arn || '') + '" class="' + icls + '">' +
            cols.map(function(col) { return '<td>' + renderColumnCell(inst, col) + '</td>'; }).join('') +
            '</tr>');
          rowResources.push(inst);
        });
      });
      if (standalone.length > 0) {
        rowHtml.push('<tr class="cv-row-standalone-hdr"><td colspan="' + cols.length + '">Standalone DB instances (not in an Aurora cluster)</td></tr>');
        standalone.forEach(function(s) {
          var scls = s.arn === selectedArn ? 'selected cv-row-child' : 'cv-row-child';
          rowHtml.push('<tr data-arn="' + escHtml(s.arn || '') + '" class="' + scls + '">' +
            cols.map(function(col) { return '<td>' + renderColumnCell(s, col) + '</td>'; }).join('') +
            '</tr>');
          rowResources.push(s);
        });
      }
      var tbody = document.getElementById('cv-tbody');
      if (rowHtml.length === 0) {
        tbody.innerHTML = '<tr><td class="cv-empty" colspan="' + cols.length + '"><span class="cv-empty-icon">\\u2601</span>No clusters or instances found</td></tr>';
        return;
      }
      tbody.innerHTML = rowHtml.join('');
      bindRowClicks(rowResources);
    }

    function renderVpcHierarchyTable(filtered) {
      document.getElementById('cv-count').textContent = filtered.length + ' of ' + ALL_RESOURCES.length;
      renderTableHead();
      var vpcs = filtered.filter(function(r) { return r.resourceType === 'aws.ec2.vpc'; });
      var subnets = filtered.filter(function(r) { return r.resourceType === 'aws.ec2.subnet'; });
      var byVpc = {};
      vpcs.forEach(function(v) { byVpc[v.id] = { vpc: v, subnets: [] }; });
      var orphan = [];
      subnets.forEach(function(s) {
        var vid = String(getVal(s, 'VpcId') || '');
        if (vid && byVpc[vid]) {
          byVpc[vid].subnets.push(s);
        } else {
          orphan.push(s);
        }
      });
      vpcs.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
      orphan.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });

      var rowHtml = [];
      var rowResources = [];
      vpcs.forEach(function(v) {
        var cls = v.arn === selectedArn ? 'selected cv-row-cluster' : 'cv-row-cluster';
        rowHtml.push('<tr data-arn="' + escHtml(v.arn || '') + '" class="' + cls + '">' +
          COLUMNS.map(function(col) { return '<td>' + renderColumnCell(v, col) + '</td>'; }).join('') +
          '</tr>');
        rowResources.push(v);
        byVpc[v.id].subnets.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
        byVpc[v.id].subnets.forEach(function(sn) {
          var scls = sn.arn === selectedArn ? 'selected cv-row-child' : 'cv-row-child';
          rowHtml.push('<tr data-arn="' + escHtml(sn.arn || '') + '" class="' + scls + '">' +
            COLUMNS.map(function(col) { return '<td>' + renderColumnCell(sn, col) + '</td>'; }).join('') +
            '</tr>');
          rowResources.push(sn);
        });
      });
      if (orphan.length > 0) {
        rowHtml.push('<tr class="cv-row-standalone-hdr"><td colspan="' + COLUMNS.length + '">Subnets whose VPC is not in this list (other VPCs or filters)</td></tr>');
        orphan.forEach(function(s) {
          var ocls = s.arn === selectedArn ? 'selected cv-row-child' : 'cv-row-child';
          rowHtml.push('<tr data-arn="' + escHtml(s.arn || '') + '" class="' + ocls + '">' +
            COLUMNS.map(function(col) { return '<td>' + renderColumnCell(s, col) + '</td>'; }).join('') +
            '</tr>');
          rowResources.push(s);
        });
      }
      var tbody = document.getElementById('cv-tbody');
      if (rowHtml.length === 0) {
        tbody.innerHTML = '<tr><td class="cv-empty" colspan="' + COLUMNS.length + '"><span class="cv-empty-icon">\\u2601</span>No VPCs or subnets found</td></tr>';
        return;
      }
      tbody.innerHTML = rowHtml.join('');
      bindRowClicks(rowResources);
    }

    function renderTable() {
      var filtered = getFilteredByTab(activeTab);
      if (activeChip) {
        filtered = filtered.filter(function(r) {
          var st = String(getVal(r, 'State.Name') || getVal(r, 'State') || getVal(r, 'DBInstanceStatus') || getVal(r, 'ClusterStatus') || getVal(r, 'TableStatus') || '').toLowerCase();
          return st === activeChip;
        });
      }
      var q = filterText.toLowerCase();
      if (q) {
        filtered = filtered.filter(function(r) {
          return COLUMNS.some(function(c) { return String(getVal(r, c.key) || '').toLowerCase().indexOf(q) !== -1; }) ||
            (r.arn || '').toLowerCase().indexOf(q) !== -1;
        });
      }

      var col = COLUMNS[sortCol];
      if (col && !((SERVICE_ID === 'rds' && activeTab === 'rds_hierarchy') || (SERVICE_ID === 'vpc' && activeTab === 'vpc_hierarchy'))) {
        filtered.sort(function(a, b) {
          var va = String(getVal(a, col.key) || '').toLowerCase();
          var vb = String(getVal(b, col.key) || '').toLowerCase();
          return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
      }

      document.getElementById('cv-count').textContent = filtered.length + ' of ' + ALL_RESOURCES.length;

      if (SERVICE_ID === 'rds' && activeTab === 'rds_hierarchy') {
        renderRdsHierarchyTable(filtered);
        return;
      }

      if (SERVICE_ID === 'vpc' && activeTab === 'vpc_hierarchy') {
        renderVpcHierarchyTable(filtered);
        return;
      }

      renderTableHead(visibleColumnsForTab(activeTab));

      var activeCols = visibleColumnsForTab(activeTab);
      var tbody = document.getElementById('cv-tbody');
      if (filtered.length === 0) {
        var hint = (filterText || activeChip) ? 'Try clearing the search or active filter.' : 'No resources match the selected tab.';
        tbody.innerHTML = '<tr><td class="cv-empty" colspan="' + activeCols.length + '"><span class="cv-empty-icon">\\u2601</span>No resources found<br><span style="font-size:11px;color:var(--muted);font-weight:400;">' + escHtml(hint) + '</span></td></tr>';
        return;
      }
      tbody.innerHTML = filtered.map(function(r) {
        var classes = [];
        if (r.arn === selectedArn) classes.push('selected');
        var extra = cfnRowClass(r);
        if (extra) classes.push(extra.trim());
        var cls = classes.length ? ' class="' + classes.join(' ') + '"' : '';
        return '<tr data-arn="' + escHtml(r.arn || '') + '"' + cls + '>' +
          activeCols.map(function(c) { return '<td>' + renderColumnCell(r, c) + '</td>'; }).join('') +
          '</tr>';
      }).join('');

      // MSK topics button is special — opens drawer and auto-loads
      tbody.querySelectorAll('button[data-topics-arn]').forEach(function(btn) {
        btn.onclick = function(ev) {
          ev.stopPropagation();
          var arn = btn.dataset.topicsArn;
          var found = filtered.find(function(r) { return r.arn === arn; });
          if (!found) return;
          selectedArn = arn;
          openDrawer(found);
          renderTable();
          setTimeout(function() {
            var loadBtn = document.getElementById('msk-load-topics');
            if (loadBtn && !loadBtn.disabled) { loadBtn.click(); }
            var anchor = document.getElementById('msk-topics-wrap');
            if (anchor && anchor.scrollIntoView) { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          }, 50);
        };
      });

      // Data-driven click bindings for all standard action buttons
      var BTN_BINDINGS = [
        { attr: 'data-invoke-arn', msgType: 'invokeLambda', arnKey: 'invokeArn' },
        { attr: 'data-execute-arn', msgType: 'executeStateMachine', arnKey: 'executeArn' },
        { attr: 'data-logs-browse-arn', msgType: 'logsBrowseStreams', arnKey: 'logsBrowseArn' },
        { attr: 'data-ecr-images-arn', msgType: 'viewEcrImages', arnKey: 'ecrImagesArn' },
        { attr: 'data-s3-browse-arn', msgType: 's3BrowsePrefixes', arnKey: 's3BrowseArn' },
        { attr: 'data-cfn-delete-arn', msgType: 'deleteCfnStack', arnKey: 'cfnDeleteArn' },
        { attr: 'data-sqs-view-arn', msgType: 'sqsViewMessages', arnKey: 'sqsViewArn' },
        { attr: 'data-ddb-peek-arn', msgType: 'dynamodbPeekItems', arnKey: 'ddbPeekArn' },
        { attr: 'data-cfn-tpl-arn', msgType: 'cfnViewTemplate', arnKey: 'cfnTplArn' },
      ];
      BTN_BINDINGS.forEach(function(binding) {
        tbody.querySelectorAll('button[' + binding.attr + ']').forEach(function(btn) {
          btn.onclick = function(ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: binding.msgType, arn: btn.dataset[binding.arnKey] });
          };
        });
      });

      tbody.querySelectorAll('button.cv-table-ec2-startstop').forEach(function(btn) {
        btn.onclick = function(ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'runAction', arn: btn.getAttribute('data-arn'), actionId: btn.getAttribute('data-cv-action') });
        };
      });

      tbody.querySelectorAll('button.cv-table-rds-startstop').forEach(function(btn) {
        btn.onclick = function(ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'runAction', arn: btn.getAttribute('data-arn'), actionId: btn.getAttribute('data-cv-action') });
        };
      });

      tbody.querySelectorAll('button.cv-table-ecs-scale').forEach(function(btn) {
        btn.onclick = function(ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'runAction', arn: btn.getAttribute('data-arn'), actionId: btn.getAttribute('data-cv-action') });
        };
      });

      tbody.querySelectorAll('tr[data-arn]').forEach(function(tr) {
        tr.onclick = function() {
          selectedArn = tr.dataset.arn;
          openDrawer(filtered.find(function(r) { return r.arn === selectedArn; }));
          renderTable();
        };
      });
    }

    function rdsClusterStatusFromRow(resource) {
      var raw = resource._rawJson || {};
      var s = raw.Status || raw.ClusterStatus || resource.Status || '';
      return String(s).trim().toLowerCase();
    }
    function rdsInstanceStatusFromRow(resource) {
      var raw = resource._rawJson || {};
      var s = raw.DBInstanceStatus || resource.DBInstanceStatus || '';
      return String(s).trim().toLowerCase();
    }
    function rdsInstanceInClusterFromRow(resource) {
      var raw = resource._rawJson || {};
      var cid = raw.DBClusterIdentifier;
      return cid != null && String(cid).length > 0;
    }
    /** Host cvActionIds + explicit RDS start/stop rules (must match actionRegistry). */
    function drawerActionVisible(a, resource) {
      if (a.types && a.types.length > 0 && a.types.indexOf(resource.resourceType) === -1) return false;
      var id = a.id;
      if (IS_RDS) {
        if (resource.resourceType === 'aws.rds.cluster') {
          if (id === 'cloudView.rds.startCluster') return rdsClusterStatusFromRow(resource) === 'stopped';
          if (id === 'cloudView.rds.stopCluster') {
            var cs = rdsClusterStatusFromRow(resource);
            return cs === 'available' || cs === 'backing-up';
          }
        }
        if (resource.resourceType === 'aws.rds.instance') {
          if (id === 'cloudView.rds.startInstance' || id === 'cloudView.rds.stopInstance') {
            if (rdsInstanceInClusterFromRow(resource)) return false;
            var st = rdsInstanceStatusFromRow(resource);
            if (id === 'cloudView.rds.startInstance') return st === 'stopped';
            if (id === 'cloudView.rds.stopInstance') return st === 'available' || st === 'storage-optimization';
          }
        }
      }
      if (IS_ECS && (id === 'cloudView.ecs.scaleFromZero' || id === 'cloudView.ecs.scaleToZero')) {
        if (resource.resourceType !== 'aws.ecs.service') return false;
        var rj2 = resource._rawJson || {};
        var d2 = rj2.desiredCount != null ? Number(rj2.desiredCount) : Number(resource.desiredCount);
        if (isNaN(d2)) return false;
        if (id === 'cloudView.ecs.scaleToZero') return d2 > 0;
        return d2 === 0;
      }
      var ids = resource.cvActionIds;
      if (ids && ids.length > 0 && ids.indexOf(id) === -1) return false;
      return true;
    }

    function openDrawer(resource) {
      if (!resource) return;
      document.getElementById('cv-drawer-name').textContent = resource.name || resource.id;
      document.getElementById('cv-drawer-arn').textContent = resource.arn || '';

      var html = '';

      html += '<div class="cv-detail-section"><div class="cv-detail-section-title">Properties</div>';
      html += '<div class="cv-detail-row"><div class="cv-detail-key">ARN</div><div class="cv-detail-val">' + escHtml(String(resource.arn || '')) + '</div></div>';
      html += '<div class="cv-detail-row"><div class="cv-detail-key">ID</div><div class="cv-detail-val">' + escHtml(String(resource.id || '')) + '</div></div>';
      html += '<div class="cv-detail-row"><div class="cv-detail-key">Region</div><div class="cv-detail-val">' + escHtml(String(resource.region || '')) + '</div></div>';
      html += '<div class="cv-detail-row"><div class="cv-detail-key">Account</div><div class="cv-detail-val">' + escHtml(String(resource.accountId || '')) + '</div></div>';

      COLUMNS.forEach(function(c) {
        if (['name', 'id'].indexOf(c.key) === -1) {
          var v = getVal(resource, c.key);
          if (v !== undefined && v !== null && v !== '') {
            html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(c.label) + '</div><div class="cv-detail-val">' + escHtml(String(v)) + '</div></div>';
          }
        }
      });
      html += '</div>';

      var raw = resource._rawJson || {};
      var shownKeys = new Set(COLUMNS.map(function(c) { return c.key.split('.')[0]; }));
      var extra = Object.keys(raw).filter(function(k) { return !shownKeys.has(k) && raw[k] !== undefined && raw[k] !== null; });
      if (extra.length > 0) {
        html += '<div class="cv-detail-section"><div class="cv-detail-section-title">Additional Properties</div>';
        extra.forEach(function(k) {
          var v = raw[k];
          var display = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
          if (display.length > 200) display = display.substring(0, 197) + '...';
          html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(k) + '</div><div class="cv-detail-val">' + escHtml(display) + '</div></div>';
        });
        html += '</div>';
      }

      var tags = resource._tags || resource.tags || {};
      var tagKeys = Object.keys(tags);
      if (tagKeys.length > 0) {
        html += '<div class="cv-detail-section"><div class="cv-detail-section-title">Tags (' + tagKeys.length + ')</div>';
        tagKeys.sort().forEach(function(k) {
          html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(k) + '</div><div class="cv-detail-val">' + escHtml(String(tags[k])) + '</div></div>';
        });
        html += '</div>';
      }

      if (IS_RDS && resource.resourceType === 'aws.rds.cluster') {
        var members = ALL_RESOURCES.filter(function(r) {
          return r.resourceType === 'aws.rds.instance' && String(getVal(r, 'DBClusterIdentifier') || '') === String(resource.id || '');
        });
        if (members.length > 0) {
          html += '<div class="cv-detail-section"><div class="cv-detail-section-title">DB instances in this cluster (' + members.length + ')</div>';
          members.forEach(function(m) {
            html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(m.name || '') + '</div><div class="cv-detail-val">' +
              escHtml(String(getVal(m, 'DBInstanceClass') || '') + ' \\u00B7 ' + String(getVal(m, 'DBInstanceStatus') || '')) + '</div></div>';
          });
          html += '</div>';
        }
      }

      if (IS_VPC && resource.resourceType === 'aws.ec2.vpc') {
        var vpcSubs = ALL_RESOURCES.filter(function(r) {
          return r.resourceType === 'aws.ec2.subnet' && String(getVal(r, 'VpcId') || '') === String(resource.id || '');
        });
        if (vpcSubs.length > 0) {
          vpcSubs.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
          html += '<div class="cv-detail-section"><div class="cv-detail-section-title">Subnets in this VPC (' + vpcSubs.length + ')</div>';
          vpcSubs.forEach(function(s) {
            html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(s.name || s.id) + '</div><div class="cv-detail-val">' +
              escHtml(String(getVal(s, 'CidrBlock') || '') + ' \\u00B7 ' + String(getVal(s, 'AvailabilityZone') || '')) + '</div></div>';
          });
          html += '</div>';
        }
        var vpcEps = ALL_RESOURCES.filter(function(r) {
          return r.resourceType === 'aws.ec2.vpc-endpoint' && String(getVal(r, 'VpcId') || '') === String(resource.id || '');
        });
        if (vpcEps.length > 0) {
          vpcEps.sort(function(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
          html += '<div class="cv-detail-section"><div class="cv-detail-section-title">VPC endpoints in this VPC (' + vpcEps.length + ')</div>';
          vpcEps.forEach(function(e) {
            html += '<div class="cv-detail-row"><div class="cv-detail-key">' + escHtml(e.name || e.id) + '</div><div class="cv-detail-val">' +
              escHtml(String(getVal(e, 'ServiceName') || getVal(e, 'VpcEndpointType') || '') + ' \\u00B7 ' + String(getVal(e, 'State') || '')) + '</div></div>';
          });
          html += '</div>';
        }
      }

      if (IS_MSK && resource.resourceType === 'aws.msk.cluster') {
        html += '<div class="cv-detail-section" id="msk-topics-wrap"><div class="cv-detail-section-title">Kafka Topics</div>';
        html += '<p style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.4;">Loads topic names and partition counts from the MSK control plane (ListTopics). Serverless or restricted clusters may return an error.</p>';
        html += '<button type="button" class="cv-btn" id="msk-load-topics" style="width:100%;margin-bottom:8px;justify-content:center;">Load topics</button>';
        html += '<div id="msk-topics-list"></div></div>';
      }

      var rawJsonStr = JSON.stringify(resource._rawJson || {}, null, 2);
      html += '<div class="cv-detail-section">' +
        '<div class="cv-detail-section-title" style="display:flex;align-items:center;justify-content:space-between;">' +
          '<span>Raw JSON</span>' +
          '<button class="cv-btn" id="cv-copy-raw" style="padding:2px 8px;font-size:10px;">Copy</button>' +
        '</div>' +
        '<pre id="cv-raw-json" style="max-height:280px;overflow:auto;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-size:11px;font-family:ui-monospace,\\'SF Mono\\',monospace;line-height:1.45;margin:0;">' +
        escHtml(rawJsonStr) + '</pre>' +
      '</div>';

      html += '<div class="cv-detail-section"><div class="cv-detail-section-title">Actions</div>';
      ACTIONS.forEach(function(a) {
        if (!drawerActionVisible(a, resource)) return;
        html += '<button type="button" class="cv-btn" style="width:100%;margin-bottom:6px;justify-content:center;" data-cv-action="' + escHtml(a.id) + '" data-arn="' + escHtml(resource.arn || '') + '">' + escHtml(a.title) + '</button>';
      });
      if (HAS_LOGS) {
        html += '<button class="cv-btn" style="width:100%;margin-bottom:6px;justify-content:center;border-color:#FF9900;color:#FF9900;" data-logs="true" data-arn="' + escHtml(resource.arn || '') + '">\\u{1F4CB} View CloudWatch Logs</button>';
      }
      html += '<button class="cv-btn" style="width:100%;margin-bottom:6px;justify-content:center;border-color:#8C4FFF;color:#8C4FFF;" data-graph="true" data-arn="' + escHtml(resource.arn || '') + '">\\u{1F517} Open Graph View</button>';
      if (IS_CFN && resource.resourceType === 'aws.cloudformation.stack') {
        html += '<button class="cv-btn cv-danger-btn" style="width:100%;margin-top:8px;justify-content:center;" data-delete-stack="true" data-arn="' + escHtml(resource.arn || '') + '">\\u{1F5D1} Delete Stack</button>';
      }
      if (IS_SFN && resource.resourceType === 'aws.stepfunctions.state-machine') {
        html += '<button class="cv-btn" style="width:100%;margin-top:8px;justify-content:center;border-color:#C925D1;color:#C925D1;" data-execute-sm="true" data-arn="' + escHtml(resource.arn || '') + '">\\u25B6 Start Execution &amp; View History</button>';
      }
      html += '</div>';

      document.getElementById('cv-drawer-body').innerHTML = html;

      var loadTopicsBtn = document.getElementById('msk-load-topics');
      if (loadTopicsBtn && IS_MSK && resource.resourceType === 'aws.msk.cluster') {
        loadTopicsBtn.onclick = function() {
          loadTopicsBtn.disabled = true;
          loadTopicsBtn.textContent = 'Loading...';
          vscode.postMessage({ type: 'listMskTopics', clusterArn: resource.arn });
        };
      }

      document.querySelectorAll('[data-cv-action]').forEach(function(btn) {
        btn.onclick = function() {
          vscode.postMessage({
            type: 'runAction',
            arn: btn.getAttribute('data-arn'),
            actionId: btn.getAttribute('data-cv-action'),
          });
        };
      });
      document.querySelectorAll('[data-logs]').forEach(function(btn) {
        btn.onclick = function() { vscode.postMessage({ type: 'viewLogs', arn: btn.dataset.arn }); };
      });
      document.querySelectorAll('[data-graph]').forEach(function(btn) {
        btn.onclick = function() { vscode.postMessage({ type: 'openResource', arn: btn.dataset.arn }); };
      });
      document.querySelectorAll('[data-delete-stack]').forEach(function(btn) {
        btn.onclick = function() { vscode.postMessage({ type: 'deleteCfnStack', arn: btn.dataset.arn }); };
      });
      document.querySelectorAll('[data-execute-sm]').forEach(function(btn) {
        btn.onclick = function() { vscode.postMessage({ type: 'executeStateMachine', arn: btn.dataset.arn }); };
      });

      var copyRawBtn = document.getElementById('cv-copy-raw');
      if (copyRawBtn) {
        copyRawBtn.onclick = function(ev) {
          ev.stopPropagation();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(rawJsonStr).then(function() {
              var orig = copyRawBtn.textContent;
              copyRawBtn.textContent = 'Copied!';
              setTimeout(function() { copyRawBtn.textContent = orig; }, 1200);
            });
          }
        };
      }

      document.getElementById('cv-drawer').classList.add('open');
      document.getElementById('cv-overlay').style.display = 'block';
    }

    function closeDrawer() {
      document.getElementById('cv-drawer').classList.remove('open');
      document.getElementById('cv-overlay').style.display = 'none';
      selectedArn = null;
      renderTable();
    }

    function exportCsv() {
      var filtered = getFilteredByTab(activeTab);
      var header = COLUMNS.map(function(c) { return '"' + c.label.replace(/"/g, '""') + '"'; }).join(',');
      var rows = filtered.map(function(r) {
        return COLUMNS.map(function(c) {
          var v = getVal(r, c.key);
          return '"' + String(v !== undefined && v !== null ? v : '').replace(/"/g, '""') + '"';
        }).join(',');
      });
      var csv = header + '\\n' + rows.join('\\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = '${csvFilename}_export.csv';
      a.click(); URL.revokeObjectURL(url);
    }

    document.getElementById('cv-filter').oninput = function() { filterText = this.value; renderTable(); };
    document.getElementById('cv-overlay').onclick = closeDrawer;
    document.getElementById('cv-drawer-close').onclick = closeDrawer;
    document.getElementById('cv-export').onclick = exportCsv;
    document.getElementById('cv-refresh').onclick = function() { vscode.postMessage({ type: 'refresh' }); };
    document.getElementById('cv-service-graph').onclick = function() { vscode.postMessage({ type: 'serviceGraph' }); };

    var copyArnBtn = document.getElementById('cv-drawer-copy-arn');
    if (copyArnBtn) {
      copyArnBtn.onclick = function() {
        var arn = document.getElementById('cv-drawer-arn').textContent || '';
        if (!arn || !navigator.clipboard) return;
        navigator.clipboard.writeText(arn).then(function() {
          var orig = copyArnBtn.textContent;
          copyArnBtn.textContent = 'Copied!';
          setTimeout(function() { copyArnBtn.textContent = orig; }, 1200);
        });
      };
    }

    document.addEventListener('keydown', function(e) {
      var tag = (e.target && e.target.tagName) || '';
      var inInput = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        var drawer = document.getElementById('cv-drawer');
        if (drawer && drawer.classList.contains('open')) {
          closeDrawer();
        } else if (filterText || activeChip) {
          filterText = '';
          activeChip = null;
          var f = document.getElementById('cv-filter');
          if (f) { f.value = ''; }
          renderChips();
          renderTable();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('cv-filter').focus();
        return;
      }
      if (inInput) { return; }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('cv-filter').focus();
      }
      if (e.key === 'r' || e.key === 'R') {
        vscode.postMessage({ type: 'refresh' });
      }
    });

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'updateResources') {
        ALL_RESOURCES = msg.resources;
        STATS = msg.stats;
        renderStats(); renderTabs(); renderChips(); renderTable();
      }
      if (msg.type === 'mskTopicsResult') {
        var loadBtn = document.getElementById('msk-load-topics');
        if (loadBtn) {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Reload topics';
        }
        var listEl = document.getElementById('msk-topics-list');
        if (!listEl) return;
        if (msg.error) {
          listEl.innerHTML = '<p style="color:#b91c1c;font-size:12px;line-height:1.4;">' + escHtml(msg.error) + '</p>';
          return;
        }
        var topics = msg.topics || [];
        if (topics.length === 0) {
          listEl.innerHTML = '<p style="font-size:12px;color:var(--muted);">No topics returned.</p>';
          return;
        }
        var thead = '<thead><tr><th>Topic</th><th>Partitions</th><th>Replication</th></tr></thead>';
        var body = '<tbody>' + topics.map(function(t) {
          return '<tr><td>' + escHtml(t.topicName || '') + '</td><td>' + escHtml(String(t.partitionCount != null ? t.partitionCount : "")) + '</td><td>' + escHtml(String(t.replicationFactor != null ? t.replicationFactor : "")) + '</td></tr>';
        }).join('') + '</tbody>';
        listEl.innerHTML = '<table style="width:100%;font-size:11px;border-collapse:collapse;">' + thead + body + '</table>';
      }
    });

    renderStats();
    renderTabs();
    renderChips();
    renderTable();
  </script>
</body>
</html>`;
  }
}
