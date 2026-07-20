import * as vscode from "vscode";
import {
  ListShardsCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
  ShardIteratorType,
  type _Record,
  type Shard,
} from "@aws-sdk/client-kinesis";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Kinesis Data Stream **peek** panel.
 *
 * Pick a shard + starting iterator (LATEST / TRIM_HORIZON / AT_TIMESTAMP)
 * and read up to N records. Reads are non-destructive — Kinesis has no
 * consumer-group state coupling like SQS visibility does, so GetRecords is
 * pure read; nothing is consumed on our behalf.
 *
 * The panel decodes the Data payload as UTF-8 by default and pretty-prints
 * JSON when possible, falling back to hex for non-UTF-8 bytes so binary
 * producers still get a legible preview.
 */
export class KinesisPeekPanel {
  private static panels = new Map<string, KinesisPeekPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly streamName: string;
  private readonly streamArn: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.streamName = resource.name || resource.id;
    this.streamArn = resource.arn;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewKinesisPeek",
      `Kinesis: ${this.streamName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => KinesisPeekPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "listShards") {
          await this.loadShards();
        } else if (msg.type === "peek") {
          await this.peekRecords(
            String(msg.shardId ?? ""),
            String(msg.iteratorType ?? "LATEST") as ShardIteratorType,
            typeof msg.timestamp === "string" ? msg.timestamp : undefined,
            Number(msg.limit) || 25,
          );
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = KinesisPeekPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new KinesisPeekPanel(platform, resource);
    KinesisPeekPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadShards(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.kinesis(scope);

    const shards: Shard[] = [];
    let nextToken: string | undefined;
    try {
      // Cap at 5 pages × 1000 shards = 5000. Way past the point where a
      // shard picker is useful; users on huge streams filter server-side.
      for (let i = 0; i < 5; i += 1) {
        const resp = await this.platform.scheduler.run("kinesis", "ListShards", () =>
          client.send(new ListShardsCommand({
            StreamName: i === 0 && !nextToken ? this.streamName : undefined,
            NextToken: nextToken,
            MaxResults: 1000,
          })),
        );
        for (const s of resp.Shards ?? []) shards.push(s);
        nextToken = resp.NextToken;
        if (!nextToken) break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`ListShards failed: ${message}`);
      return;
    }

    const payload = shards.map((s) => ({
      shardId: s.ShardId,
      parentShardId: s.ParentShardId,
      // A closed shard has a EndingSequenceNumber set. Callers still may
      // want to peek historical data on closed shards.
      isClosed: Boolean(s.SequenceNumberRange?.EndingSequenceNumber),
      hashKeyRange: s.HashKeyRange
        ? { starting: s.HashKeyRange.StartingHashKey, ending: s.HashKeyRange.EndingHashKey }
        : undefined,
    }));
    void this.panel.webview.postMessage({ type: "shards", shards: payload });
  }

  private async peekRecords(
    shardId: string,
    iteratorType: ShardIteratorType,
    timestampIso: string | undefined,
    limit: number,
  ): Promise<void> {
    if (!shardId) {
      this.postError("Pick a shard first.");
      return;
    }
    const scope = await this.resolveScope();
    if (!scope) return;
    const client = await this.platform.awsClientFactory.kinesis(scope);

    // ── Get a shard iterator ──────────────────────────────────────────
    let iterator: string | undefined;
    try {
      const iterResp = await this.platform.scheduler.run("kinesis", "GetShardIterator", () =>
        client.send(new GetShardIteratorCommand({
          StreamName: this.streamName,
          ShardId: shardId,
          ShardIteratorType: iteratorType,
          Timestamp: iteratorType === "AT_TIMESTAMP" && timestampIso
            ? new Date(timestampIso)
            : undefined,
        })),
      );
      iterator = iterResp.ShardIterator;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`GetShardIterator failed: ${message}`);
      return;
    }

    if (!iterator) {
      this.postError("No shard iterator returned.");
      return;
    }

    // ── Fetch records ─────────────────────────────────────────────────
    // A single GetRecords call returns at most 10K records / 10MiB / 5s of
    // data. For a peek, one call at the requested Limit is plenty; iterator
    // chaining is left to producer/consumer applications, not this browser.
    try {
      const resp = await this.platform.scheduler.run("kinesis", "GetRecords", () =>
        client.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: limit })),
      );
      const records = (resp.Records ?? []).map(serializeRecord);
      void this.panel.webview.postMessage({
        type: "records",
        records,
        millisBehindLatest: resp.MillisBehindLatest,
        shardId,
        iteratorType,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`GetRecords failed: ${message}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.streamName);
    const arn = escapeHtml(this.streamArn);
    const region = escapeHtml(this.resource.region);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>Kinesis Peek: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; flex-shrink: 0; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #7B2FBE; font-size: 18px; }
    .meta { display: flex; gap: 14px; margin-top: 4px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }
    .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; }
    .field { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .field label { color: var(--muted); font-weight: 600; }
    select, input[type=number], input[type=datetime-local] {
      background: var(--surface); color: var(--text); border: 1px solid var(--border-2);
      padding: 4px 8px; border-radius: var(--radius-sm); font-size: 11px; font-family: inherit;
    }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }
    .btn.primary { background: #7B2FBE; border-color: #7B2FBE; color: #fff; }
    .btn.primary:hover { background: #6a26a6; border-color: #6a26a6; }
    .status { margin-left: auto; font-size: 11px; color: var(--muted); }

    .body { flex: 1; overflow: auto; padding: 12px 20px; }
    .empty { padding: 40px; text-align: center; color: var(--light); }
    .rec {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      margin-bottom: 10px; padding: 10px 14px; font-size: 12px;
    }
    .rec-hdr { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; font-size: 11px; color: var(--muted); }
    .rec-hdr .k { font-weight: 600; color: var(--text); }
    .rec-hdr code { font-family: 'SF Mono','Fira Code',monospace; }
    .payload { background: var(--surface-2); border-radius: var(--radius-sm); padding: 8px 10px; margin-top: 4px; overflow: auto; max-height: 260px; white-space: pre-wrap; word-break: break-all; font-family: 'SF Mono','Fira Code',monospace; font-size: 11px; line-height: 1.45; }
    .payload.hex { color: #6b7280; }
    .encoding-pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 9px; font-weight: 700; text-transform: uppercase; background: #e0e7ff; color: #3730a3; margin-left: 6px; letter-spacing: .3px; }
    .encoding-pill.json { background: #dcfce7; color: #166534; }
    .encoding-pill.hex { background: #fee2e2; color: #991b1b; }

    .error-banner { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px; font-size: 12px; display: none; white-space: pre-wrap; }

    .ts-field { display: none; }
    .ts-field.show { display: flex; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title"><span class="icon">⚡</span> ${name}</div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
      <span><span class="label">Records:</span> non-destructive read</span>
    </div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <div class="field">
      <label>Shard:</label>
      <select id="shard-select"><option value="">Loading…</option></select>
    </div>
    <div class="field">
      <label>Start:</label>
      <select id="iter-type">
        <option value="LATEST">LATEST (only new records)</option>
        <option value="TRIM_HORIZON">TRIM_HORIZON (oldest)</option>
        <option value="AT_TIMESTAMP">AT_TIMESTAMP</option>
      </select>
    </div>
    <div class="field ts-field" id="ts-field">
      <label>At:</label>
      <input type="datetime-local" id="iter-ts" />
    </div>
    <div class="field">
      <label>Limit:</label>
      <input type="number" id="limit" value="25" min="1" max="10000" style="width:80px" />
    </div>
    <button class="btn primary" id="peek-btn">▶ Peek</button>
    <button class="btn" id="refresh-shards">↻ Reload shards</button>
    <span class="status" id="status"></span>
  </div>

  <div class="body" id="body"><div class="empty">Pick a shard and hit <b>Peek</b>.</div></div>

  <script nonce="${n}">
    const vscode = acquireVsCodeApi();

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg){ const el=document.getElementById('error-banner'); el.textContent=msg; el.style.display='block'; setTimeout(function(){el.style.display='none';}, 9000); }
    function fmtTs(v){ if(!v) return '—'; try { return new Date(v).toLocaleString(); } catch(_) { return String(v); } }

    const shardSel = document.getElementById('shard-select');
    const iterSel = document.getElementById('iter-type');
    const tsField = document.getElementById('ts-field');
    const tsInput = document.getElementById('iter-ts');
    const limitInput = document.getElementById('limit');
    const statusEl = document.getElementById('status');
    const bodyEl = document.getElementById('body');

    iterSel.addEventListener('change', function() {
      tsField.classList.toggle('show', iterSel.value === 'AT_TIMESTAMP');
    });

    document.getElementById('peek-btn').addEventListener('click', function() {
      const shardId = shardSel.value;
      if (!shardId) { showError('Pick a shard first.'); return; }
      statusEl.textContent = 'Peeking…';
      vscode.postMessage({
        type: 'peek',
        shardId: shardId,
        iteratorType: iterSel.value,
        timestamp: iterSel.value === 'AT_TIMESTAMP' && tsInput.value ? new Date(tsInput.value).toISOString() : undefined,
        limit: Number(limitInput.value) || 25,
      });
    });
    document.getElementById('refresh-shards').addEventListener('click', function() {
      vscode.postMessage({ type: 'listShards' });
    });

    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (m.type === 'shards') {
        const opts = m.shards.map(function(s) {
          const suffix = s.isClosed ? ' (closed)' : '';
          return '<option value="' + esc(s.shardId) + '">' + esc(s.shardId) + suffix + '</option>';
        }).join('');
        shardSel.innerHTML = opts || '<option value="">(no shards)</option>';
      } else if (m.type === 'records') {
        renderRecords(m.records, m.millisBehindLatest);
      } else if (m.type === 'error') {
        showError(m.message);
        statusEl.textContent = '';
      }
    });

    function renderRecords(records, msBehind) {
      const behindTxt = (typeof msBehind === 'number' && msBehind >= 0)
        ? (msBehind === 0 ? 'at latest' : (msBehind < 1000 ? msBehind + 'ms' : Math.round(msBehind/1000) + 's') + ' behind latest')
        : '';
      statusEl.textContent = records.length + ' record' + (records.length === 1 ? '' : 's') + (behindTxt ? ' · ' + behindTxt : '');
      if (records.length === 0) {
        bodyEl.innerHTML = '<div class="empty">No records at that iterator position.<br><br>Try <b>TRIM_HORIZON</b> to read from the oldest available record.</div>';
        return;
      }
      bodyEl.innerHTML = records.map(function(r) {
        const enc = r.encoding || 'text';
        const cls = enc === 'json' ? 'json' : (enc === 'hex' ? 'hex' : '');
        return '<div class="rec">' +
          '<div class="rec-hdr">' +
            '<span><span class="k">Partition key:</span> <code>' + esc(r.partitionKey) + '</code></span>' +
            '<span><span class="k">Arrived:</span> ' + esc(fmtTs(r.arrival)) + '</span>' +
            '<span><span class="k">Seq:</span> <code>' + esc(r.sequenceNumber) + '</code></span>' +
            '<span><span class="k">Bytes:</span> ' + r.bytes + '<span class="encoding-pill ' + cls + '">' + enc + '</span></span>' +
          '</div>' +
          '<pre class="payload ' + (enc === 'hex' ? 'hex' : '') + '">' + esc(r.data) + '</pre>' +
        '</div>';
      }).join('');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode a Kinesis record payload. Kinesis stores bytes; producers typically
 * push JSON or text, occasionally binary (Protobuf/Avro/…). We try UTF-8 →
 * JSON pretty-print → fall back to hex for pure-binary payloads so users
 * still see something meaningful.
 */
function decodePayload(bytes: Uint8Array | undefined): { data: string; encoding: "json" | "text" | "hex"; size: number } {
  if (!bytes || bytes.length === 0) return { data: "", encoding: "text", size: 0 };
  const size = bytes.length;

  // Try UTF-8 first. Kinesis payloads are almost always text/JSON.
  let asText: string | undefined;
  try {
    asText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    asText = undefined;
  }

  if (asText !== undefined) {
    // JSON pretty-print when the string parses as an object/array.
    const trimmed = asText.trim();
    if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
      try {
        return { data: JSON.stringify(JSON.parse(trimmed), null, 2), encoding: "json", size };
      } catch {
        // Fall through — invalid JSON but valid UTF-8 stays as text.
      }
    }
    return { data: asText, encoding: "text", size };
  }

  // Binary fallback — hex-dump. Cap at 2 KiB so we don't render a wall of
  // digits for large binary payloads.
  const cap = Math.min(size, 2048);
  const parts: string[] = [];
  for (let i = 0; i < cap; i += 1) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
    if ((i + 1) % 16 === 0) parts.push("\n");
    else parts.push(" ");
  }
  const suffix = size > cap ? `\n… ${size - cap} more bytes` : "";
  return { data: parts.join("").trim() + suffix, encoding: "hex", size };
}

function serializeRecord(r: _Record): {
  partitionKey: string;
  sequenceNumber: string;
  arrival: string | undefined;
  data: string;
  encoding: "json" | "text" | "hex";
  bytes: number;
} {
  const decoded = decodePayload(r.Data);
  return {
    partitionKey: r.PartitionKey ?? "",
    sequenceNumber: r.SequenceNumber ?? "",
    arrival: r.ApproximateArrivalTimestamp ? r.ApproximateArrivalTimestamp.toISOString() : undefined,
    data: decoded.data,
    encoding: decoded.encoding,
    bytes: decoded.size,
  };
}
