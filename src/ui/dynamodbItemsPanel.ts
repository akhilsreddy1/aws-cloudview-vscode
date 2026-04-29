import * as vscode from "vscode";
import {
  ScanCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

interface PeekedItem {
  /** Primary-key summary, e.g. `userId=abc, createdAt=2026-04-25T...`. */
  keySummary: string;
  /** Fully-unmarshalled item as plain JS, for JSON display. */
  item: Record<string, unknown>;
}

interface KeyAttr {
  name: string;
  keyType: "HASH" | "RANGE";
}

/**
 * Webview for a DynamoDB table: peek items via Scan (any table, no input) or
 * Query (when a RANGE key exists, sorted newest-first via `ScanIndexForward=false`).
 *
 * Reads are non-destructive. The panel never writes, updates, or deletes.
 * Scan and Query are both Limit-bounded so cost stays predictable.
 */
export class DynamoDbItemsPanel {
  private static panels = new Map<string, DynamoDbItemsPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly tableName: string;
  private readonly keySchema: KeyAttr[];

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.tableName = (resource.rawJson.TableName as string) ?? resource.name ?? resource.id;
    this.keySchema = parseKeySchema(resource.rawJson.KeySchema);

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewDynamoDbItems",
      `DynamoDB: ${this.tableName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => DynamoDbItemsPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "scan") {
          await this.scanLatest(Number(msg.limit) || 10);
        } else if (msg.type === "queryLatest") {
          await this.queryLatest(
            String(msg.partitionValue ?? ""),
            String(msg.partitionType ?? "S"),
            Number(msg.limit) || 10,
          );
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = DynamoDbItemsPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new DynamoDbItemsPanel(platform, resource);
    DynamoDbItemsPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  /**
   * Scan with a small Limit. Items are returned in DynamoDB-internal order
   * (no real "latest" guarantee); this is the only mode that works on any
   * table without user input.
   */
  private async scanLatest(limit: number): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const capped = Math.max(1, Math.min(limit, 50));

    const client = await this.platform.awsClientFactory.dynamodb(scope);
    const resp = await this.platform.scheduler.run("dynamodb", "Scan", () =>
      client.send(new ScanCommand({ TableName: this.tableName, Limit: capped }))
    );
    const items = (resp.Items ?? []).map((m) => this.shapeItem(m));
    void this.panel.webview.postMessage({
      type: "itemsResult",
      mode: "scan",
      items,
      scannedCount: resp.ScannedCount,
      consumedCapacity: resp.ConsumedCapacity?.CapacityUnits,
    });
  }

  /**
   * Query a single partition with `ScanIndexForward=false` so the most recent
   * sort-key values come first. Requires the table to have a RANGE key.
   */
  private async queryLatest(partitionValue: string, partitionType: string, limit: number): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const capped = Math.max(1, Math.min(limit, 50));

    const hash = this.keySchema.find((k) => k.keyType === "HASH");
    if (!hash) {
      this.postError("Table has no partition key in its KeySchema.");
      return;
    }
    if (!partitionValue) {
      this.postError("Enter a partition-key value to query.");
      return;
    }

    const pkAttrValue: AttributeValue =
      partitionType === "N"
        ? ({ N: partitionValue } as AttributeValue)
        : ({ S: partitionValue } as AttributeValue);

    const client = await this.platform.awsClientFactory.dynamodb(scope);
    const resp = await this.platform.scheduler.run("dynamodb", "Query", () =>
      client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": hash.name },
        ExpressionAttributeValues: { ":pk": pkAttrValue },
        Limit: capped,  // Limit is the maximum number of items to return
        ScanIndexForward: false, // ScanIndexForward is false to get the most recent items first
      }))
    );
    const items = (resp.Items ?? []).map((m) => this.shapeItem(m));
    void this.panel.webview.postMessage({
      type: "itemsResult",
      mode: "query",
      items,
      scannedCount: resp.ScannedCount,
      consumedCapacity: resp.ConsumedCapacity?.CapacityUnits,
    });
  }

  private shapeItem(marshalled: Record<string, AttributeValue>): PeekedItem {
    const item = unmarshallItem(marshalled);
    const parts: string[] = [];
    for (const k of this.keySchema) {
      const v = item[k.name];
      if (v !== undefined) parts.push(`${k.name}=${formatKeyVal(v)}`);
    }
    return { keySummary: parts.join(", ") || "(no key)", item };
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.tableName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const accountId = escapeHtml(this.resource.accountId);
    const raw = this.resource.rawJson as Record<string, unknown>;
    const itemCount = Number(raw.ItemCount ?? 0);
    const sizeBytes = Number(raw.TableSizeBytes ?? 0);
    const status = String(raw.TableStatus ?? "");
    const hashKey = this.keySchema.find((k) => k.keyType === "HASH");
    const rangeKey = this.keySchema.find((k) => k.keyType === "RANGE");
    const canQuery = Boolean(hashKey && rangeKey);
    const keySummary = this.keySchema.map((k) => `${k.name} (${k.keyType})`).join(", ") || "(no key)";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>DynamoDB: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .ddb-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 20px; flex-shrink: 0; }
    .ddb-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .ddb-title .t-icon { color: #4053D6; font-size: 20px; }
    .ddb-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .ddb-meta span { display: flex; align-items: center; gap: 4px; }
    .ddb-meta .label { font-weight: 600; }
    .arn-row { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; word-break: break-all; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar input, .toolbar select {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .toolbar input.pk { width: 200px; font-family: 'SF Mono', 'Fira Code', monospace; }
    .btn {
      background: var(--accent); color: white; border: none;
      padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }

    .tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 20px; flex-shrink: 0; background: var(--surface); }
    .tab { padding: 10px 14px; cursor: pointer; font-size: 12px; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .content { flex: 1; overflow: auto; padding: 16px 20px; }
    .pane { display: none; }
    .pane.active { display: block; }

    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--light); padding: 40px; text-align: center; }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    .item-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; overflow: hidden; }
    .item-head {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      background: var(--surface-2); border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--muted); flex-wrap: wrap;
    }
    .item-key { font-family: 'SF Mono', 'Fira Code', monospace; font-weight: 600; color: var(--text); }
    .item-body {
      padding: 10px 12px; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      max-height: 380px; overflow: auto;
    }

    .summary-row { font-size: 11px; color: var(--muted); padding: 0 0 10px; display: flex; gap: 16px; flex-wrap: wrap; }
    .summary-row strong { color: var(--text-2); font-weight: 600; }

    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none;
    }
  </style>
</head>
<body>
  <div class="ddb-header">
    <div class="ddb-title">
      <span class="t-icon">\u{1F5C3}</span>
      <span>${name}</span>
      ${status ? `<span class="badge badge-blue" style="margin-left:6px;">${escapeHtml(status)}</span>` : ""}
    </div>
    <div class="ddb-meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Account:</span> ${accountId}</span>
      <span><span class="label">Items:</span> ${itemCount.toLocaleString()}</span>
      <span><span class="label">Size:</span> ${formatBytes(sizeBytes)}</span>
      <span><span class="label">Key:</span> ${escapeHtml(keySummary)}</span>
    </div>
    <div class="arn-row">${arn}</div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <label>Limit</label>
    <select id="limit">
      <option value="10" selected>10</option>
      <option value="25">25</option>
      <option value="50">50</option>
    </select>
    <button class="btn" id="scan-btn">\u{1F50D} Scan ${escapeHtml(this.tableName)}</button>
    ${canQuery ? `
      <span style="flex:1;"></span>
      <label>${escapeHtml(hashKey!.name)} =</label>
      <input id="pk-value" class="pk" type="text" placeholder="partition key value" />
      <select id="pk-type" title="Partition key type">
        <option value="S" selected>String</option>
        <option value="N">Number</option>
      </select>
      <button class="btn ghost" id="query-btn">\u{1F53D} Query latest (sort ↓)</button>
    ` : ""}
  </div>

  <div class="content">
    <div class="pane active" id="pane-items">
      <div id="summary" class="summary-row" style="display:none;"></div>
      <div class="empty-state" id="empty">
        <div class="icon">\u{1F5C3}</div>
        <div>Click <strong>Scan</strong> to peek up to 50 items.</div>
        ${canQuery ? `<div style="font-size: 11px; margin-top: 6px;">Or enter a value for <code>${escapeHtml(hashKey!.name)}</code> and click <strong>Query latest</strong> for newest items in that partition (sorted by <code>${escapeHtml(rangeKey!.name)}</code> descending).</div>` : "<div style=\"font-size: 11px; margin-top: 6px;\">This table has no sort key, so Scan is the only peek mode available.</div>"}
      </div>
      <div id="items-list"></div>
    </div>
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var scanBtn = document.getElementById('scan-btn');
    var queryBtn = document.getElementById('query-btn');
    var pkInput = document.getElementById('pk-value');
    var pkType = document.getElementById('pk-type');
    var limitSel = document.getElementById('limit');
    var errorBanner = document.getElementById('error-banner');

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      setTimeout(function(){ errorBanner.style.display = 'none'; }, 8000);
    }

    scanBtn.onclick = function() {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning…';
      vscode.postMessage({ type: 'scan', limit: Number(limitSel.value) });
    };
    if (queryBtn) {
      queryBtn.onclick = function() {
        var v = pkInput.value;
        if (!v) { showError('Enter a partition-key value first.'); return; }
        queryBtn.disabled = true;
        queryBtn.textContent = 'Querying…';
        vscode.postMessage({ type: 'queryLatest', partitionValue: v, partitionType: pkType.value, limit: Number(limitSel.value) });
      };
    }

    function renderItems(items, mode, scannedCount, consumedCapacity) {
      var container = document.getElementById('items-list');
      var empty = document.getElementById('empty');
      var summary = document.getElementById('summary');
      if (!items || items.length === 0) {
        empty.style.display = 'flex';
        empty.querySelector('div:nth-child(2)').innerHTML = mode === 'query'
          ? 'No items found in that partition.'
          : 'Table returned no items.';
        container.innerHTML = '';
        summary.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      var bits = ['<strong>' + items.length + '</strong> item' + (items.length === 1 ? '' : 's')];
      bits.push('mode: <strong>' + esc(mode) + '</strong>');
      if (scannedCount != null) bits.push('scanned: <strong>' + scannedCount + '</strong>');
      if (consumedCapacity != null) bits.push('capacity: <strong>' + consumedCapacity + '</strong>');
      summary.innerHTML = bits.join(' · ');
      summary.style.display = 'flex';

      var html = '';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var pretty;
        try { pretty = JSON.stringify(it.item, null, 2); }
        catch (e) { pretty = String(it.item); }
        html += '<div class="item-card">' +
          '<div class="item-head"><span class="item-key">' + esc(it.keySummary) + '</span></div>' +
          '<div class="item-body">' + esc(pretty) + '</div>' +
          '</div>';
      }
      container.innerHTML = html;
    }

    window.addEventListener('message', function(ev) {
      var m = ev.data;
      if (m.type === 'itemsResult') {
        scanBtn.disabled = false;
        scanBtn.textContent = '\u{1F50D} Scan ${escapeHtml(this.tableName)}';
        if (queryBtn) {
          queryBtn.disabled = false;
          queryBtn.textContent = '\u{1F53D} Query latest (sort ↓)';
        }
        renderItems(m.items, m.mode, m.scannedCount, m.consumedCapacity);
      } else if (m.type === 'error') {
        scanBtn.disabled = false;
        scanBtn.textContent = '\u{1F50D} Scan ${escapeHtml(this.tableName)}';
        if (queryBtn) {
          queryBtn.disabled = false;
          queryBtn.textContent = '\u{1F53D} Query latest (sort ↓)';
        }
        showError(m.message || 'Unknown error');
      }
    });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseKeySchema(raw: unknown): KeyAttr[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyAttr[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as { AttributeName?: unknown; KeyType?: unknown };
    if (typeof obj.AttributeName !== "string") continue;
    if (obj.KeyType === "HASH" || obj.KeyType === "RANGE") {
      out.push({ name: obj.AttributeName, keyType: obj.KeyType });
    }
  }
  return out;
}

/**
 * Minimal DynamoDB AttributeValue → plain JS unmarshaller. Avoids pulling in
 * `@aws-sdk/util-dynamodb`. Numbers stay as strings when they exceed JS's
 * safe-integer range so we never silently lose precision.
 */
function unmarshallItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k] = unmarshallValue(v);
  }
  return out;
}

function unmarshallValue(v: AttributeValue): unknown {
  if (v == null) return null;
  if ("S" in v && v.S !== undefined) return v.S;
  if ("N" in v && v.N !== undefined) {
    const num = Number(v.N);
    return Number.isSafeInteger(num) || (Number.isFinite(num) && Math.abs(num) < 1e15) ? num : v.N;
  }
  if ("BOOL" in v && v.BOOL !== undefined) return v.BOOL;
  if ("NULL" in v && v.NULL !== undefined) return null;
  if ("L" in v && Array.isArray(v.L)) return v.L.map((x) => unmarshallValue(x));
  if ("M" in v && v.M) {
    const m: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v.M)) m[k] = unmarshallValue(val);
    return m;
  }
  if ("SS" in v && Array.isArray(v.SS)) return v.SS;
  if ("NS" in v && Array.isArray(v.NS)) return v.NS.map((s) => Number(s));
  if ("B" in v && v.B) return `<binary ${(v.B as Uint8Array).byteLength ?? 0} bytes>`;
  if ("BS" in v && Array.isArray(v.BS)) return `<binary set, ${v.BS.length} entries>`;
  return undefined;
}

function formatKeyVal(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 40) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 40);
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
