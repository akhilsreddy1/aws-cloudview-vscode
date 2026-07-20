import * as vscode from "vscode";
import { ListStreamConsumersCommand, type Consumer } from "@aws-sdk/client-kinesis";
import { ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { ListDeliveryStreamsCommand, DescribeDeliveryStreamCommand } from "@aws-sdk/client-firehose";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Kinesis Data Stream **targets** panel.
 */
export class KinesisTargetsPanel {
  private static panels = new Map<string, KinesisTargetsPanel>();
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
      "cloudViewKinesisTargets",
      `Targets: ${this.streamName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => KinesisTargetsPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready" || msg.type === "refresh") {
          await this.loadTargets();
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = KinesisTargetsPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new KinesisTargetsPanel(platform, resource);
    KinesisTargetsPanel.panels.set(resource.arn, instance);
  }

  private async resolveScope(): Promise<{ profileName: string; accountId: string; region: string } | undefined> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError("No AWS profile found for this account.");
      return undefined;
    }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async loadTargets(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    // Fire all three lookups in parallel — they hit different services and
    // don't share pagination state. Each catches its own error so a
    // permission denial on one section doesn't blank the others.
    const [consumers, lambdaMappings, firehoses] = await Promise.all([
      this.listConsumers(scope).catch((err: Error) => ({ error: err.message, items: [] })),
      this.listLambdaMappings(scope).catch((err: Error) => ({ error: err.message, items: [] })),
      this.listFirehoseTargets(scope).catch((err: Error) => ({ error: err.message, items: [] })),
    ]);

    void this.panel.webview.postMessage({
      type: "targets",
      consumers,
      lambdaMappings,
      firehoses,
    });
  }

  private async listConsumers(scope: { profileName: string; accountId: string; region: string }): Promise<{ items: unknown[]; error?: string }> {
    const client = await this.platform.awsClientFactory.kinesis(scope);
    const items: Consumer[] = [];
    let nextToken: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const resp = await this.platform.scheduler.run("kinesis", "ListStreamConsumers", () =>
        client.send(new ListStreamConsumersCommand({
          StreamARN: this.streamArn,
          NextToken: nextToken,
          MaxResults: 100,
        })),
      );
      for (const c of resp.Consumers ?? []) items.push(c);
      nextToken = resp.NextToken;
      if (!nextToken) break;
    }
    return {
      items: items.map((c) => ({
        name: c.ConsumerName,
        arn: c.ConsumerARN,
        status: c.ConsumerStatus,
        creationTs: c.ConsumerCreationTimestamp ? c.ConsumerCreationTimestamp.toISOString() : undefined,
      })),
    };
  }

  private async listLambdaMappings(scope: { profileName: string; accountId: string; region: string }): Promise<{ items: unknown[]; error?: string }> {
    const client = await this.platform.awsClientFactory.lambda(scope);
    const items: Array<Record<string, unknown>> = [];
    let marker: string | undefined;
    // Filter server-side by EventSourceArn so we only get mappings for THIS
    // stream. This is 1-3 orders of magnitude cheaper than pulling every
    // mapping in the region and filtering client-side.
    for (let i = 0; i < 5; i += 1) {
      const resp = await this.platform.scheduler.run("lambda", "ListEventSourceMappings", () =>
        client.send(new ListEventSourceMappingsCommand({
          EventSourceArn: this.streamArn,
          Marker: marker,
          MaxItems: 100,
        })),
      );
      for (const m of resp.EventSourceMappings ?? []) {
        items.push({
          uuid: m.UUID,
          state: m.State,
          functionArn: m.FunctionArn,
          batchSize: m.BatchSize,
          startingPosition: m.StartingPosition,
          maxBatchingWindowSec: m.MaximumBatchingWindowInSeconds,
          parallelizationFactor: m.ParallelizationFactor,
          maxRecordAgeSec: m.MaximumRecordAgeInSeconds,
          bisectBatchOnError: m.BisectBatchOnFunctionError,
          tumblingWindowSec: m.TumblingWindowInSeconds,
          lastModified: m.LastModified ? m.LastModified.toISOString() : undefined,
        });
      }
      marker = resp.NextMarker;
      if (!marker) break;
    }
    return { items };
  }

  private async listFirehoseTargets(scope: { profileName: string; accountId: string; region: string }): Promise<{ items: unknown[]; error?: string; scanned?: number }> {
    const client = await this.platform.awsClientFactory.firehose(scope);
    const matches: Array<Record<string, unknown>> = [];
    let scanned = 0;
    let exclusiveStart: string | undefined;

    // Firehose doesn't index by source stream, so we have to enumerate. Cap
    // at 100 delivery streams in the region — plenty for realistic accounts,
    // and keeps the panel snappy even when the answer is "none".
    outer: for (let page = 0; page < 2; page += 1) {
      const resp = await this.platform.scheduler.run("firehose", "ListDeliveryStreams", () =>
        client.send(new ListDeliveryStreamsCommand({
          ExclusiveStartDeliveryStreamName: exclusiveStart,
          Limit: 50,
        })),
      );
      const names = resp.DeliveryStreamNames ?? [];
      for (const name of names) {
        scanned += 1;
        try {
          const desc = await this.platform.scheduler.run("firehose", "DescribeDeliveryStream", () =>
            client.send(new DescribeDeliveryStreamCommand({ DeliveryStreamName: name })),
          );
          const src = desc.DeliveryStreamDescription?.Source?.KinesisStreamSourceDescription;
          if (src?.KinesisStreamARN === this.streamArn) {
            matches.push({
              name,
              deliveryStreamArn: desc.DeliveryStreamDescription?.DeliveryStreamARN,
              deliveryStreamType: desc.DeliveryStreamDescription?.DeliveryStreamType,
              deliveryStreamStatus: desc.DeliveryStreamDescription?.DeliveryStreamStatus,
              roleArn: src.RoleARN,
              destinations: (desc.DeliveryStreamDescription?.Destinations ?? []).map((d) => ({
                destinationId: d.DestinationId,
                s3: d.S3DestinationDescription?.BucketARN,
                extendedS3: d.ExtendedS3DestinationDescription?.BucketARN,
                redshift: d.RedshiftDestinationDescription?.ClusterJDBCURL,
                elasticsearch: d.ElasticsearchDestinationDescription?.DomainARN,
                openSearch: d.AmazonopensearchserviceDestinationDescription?.DomainARN,
                splunk: d.SplunkDestinationDescription?.HECEndpoint,
                http: d.HttpEndpointDestinationDescription?.EndpointConfiguration?.Url,
              })),
            });
          }
        } catch {
          // Skip this delivery stream — permission denials on individual
          // describe calls shouldn't nuke the whole scan.
        }
      }
      if (!resp.HasMoreDeliveryStreams) break outer;
      exclusiveStart = names.length > 0 ? names[names.length - 1] : undefined;
      if (!exclusiveStart) break;
    }
    return { items: matches, scanned };
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
  <title>Kinesis Targets: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; min-height: 100vh; }
    .hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; }
    .title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .title .icon { color: #7B2FBE; font-size: 18px; }
    .meta { display: flex; gap: 14px; margin-top: 4px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .meta .label { font-weight: 600; }
    .meta code { font-family: 'SF Mono','Fira Code',monospace; }
    .toolbar { padding: 8px 20px; background: var(--surface-2); border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center; }
    .btn { background: transparent; color: var(--text); border: 1px solid var(--border-2); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--surface-3); }
    .body { padding: 16px 20px; }
    .section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; overflow: hidden; }
    .sect-hdr { padding: 10px 14px; background: var(--surface-2); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text); display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }
    .sect-hdr .count { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: #ede9fe; color: #5b21b6; font-weight: 700; }
    .sect-hdr .icon { font-size: 14px; }
    .sect-hdr .note { margin-left: auto; font-size: 10px; color: var(--muted); font-weight: 500; text-transform: none; letter-spacing: 0; }
    .row { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 12px; }
    .row:first-child { border-top: 0; }
    .row .r-title { font-weight: 600; color: var(--text); font-family: 'SF Mono','Fira Code',monospace; word-break: break-all; }
    .row .r-meta { color: var(--muted); font-size: 11px; margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; }
    .row .r-meta code { font-family: 'SF Mono','Fira Code',monospace; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
    .badge.ok, .badge.ACTIVE, .badge.Enabled { background: #dcfce7; color: #166534; }
    .badge.pending, .badge.CREATING, .badge.UPDATING, .badge.Creating { background: #fef3c7; color: #92400e; }
    .badge.err, .badge.Disabled, .badge.Disabling, .badge.DELETING { background: #fee2e2; color: #991b1b; }
    .empty { padding: 14px; color: var(--muted); font-size: 12px; text-align: center; font-style: italic; }
    .err { padding: 10px 14px; color: #b91c1c; background: #fef2f2; border-top: 1px solid #fecaca; font-size: 11px; white-space: pre-wrap; }
    .dest-line { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .dest-line code { font-family: 'SF Mono','Fira Code',monospace; color: var(--text); }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="title"><span class="icon">⚡</span> Targets · ${name}</div>
    <div class="meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">ARN:</span> <code>${arn}</code></span>
    </div>
  </div>
  <div class="toolbar">
    <button class="btn" id="refresh-btn">↻ Refresh</button>
    <span id="status" style="font-size:11px;color:var(--muted);"></span>
  </div>
  <div class="body">
    <div class="section" id="sect-lambda">
      <div class="sect-hdr"><span class="icon">λ</span> Lambda event source mappings <span class="count" id="cnt-lambda">…</span></div>
      <div id="body-lambda"><div class="empty">Loading…</div></div>
    </div>

    <div class="section" id="sect-firehose">
      <div class="sect-hdr"><span class="icon">🔥</span> Firehose delivery streams <span class="count" id="cnt-firehose">…</span><span class="note" id="firehose-note"></span></div>
      <div id="body-firehose"><div class="empty">Loading…</div></div>
    </div>

    <div class="section" id="sect-consumers">
      <div class="sect-hdr"><span class="icon">📡</span> Enhanced fan-out consumers <span class="count" id="cnt-consumers">…</span></div>
      <div id="body-consumers"><div class="empty">Loading…</div></div>
    </div>
  </div>

  <script nonce="${n}">
    const vscode = acquireVsCodeApi();

    function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function fmtTs(v){ if(!v) return '—'; try { return new Date(v).toLocaleString(); } catch(_) { return String(v); } }

    document.getElementById('refresh-btn').addEventListener('click', function() {
      document.getElementById('status').textContent = 'Refreshing…';
      ['lambda','firehose','consumers'].forEach(function(s) {
        document.getElementById('body-' + s).innerHTML = '<div class="empty">Loading…</div>';
        document.getElementById('cnt-' + s).textContent = '…';
      });
      vscode.postMessage({ type: 'refresh' });
    });

    function renderLambda(pack) {
      const items = pack.items || [];
      document.getElementById('cnt-lambda').textContent = String(items.length);
      const body = document.getElementById('body-lambda');
      if (pack.error) { body.innerHTML = '<div class="err">' + esc(pack.error) + '</div>'; return; }
      if (items.length === 0) { body.innerHTML = '<div class="empty">No Lambda functions consume this stream.</div>'; return; }
      body.innerHTML = items.map(function(m) {
        return '<div class="row">' +
          '<div class="r-title">' + esc(m.functionArn) + '</div>' +
          '<div class="r-meta">' +
            '<span><span class="badge ' + esc(m.state || '') + '">' + esc(m.state || '') + '</span></span>' +
            '<span>Batch: <code>' + esc(m.batchSize) + '</code></span>' +
            (m.maxBatchingWindowSec ? '<span>Window: <code>' + esc(m.maxBatchingWindowSec) + 's</code></span>' : '') +
            '<span>Start: <code>' + esc(m.startingPosition) + '</code></span>' +
            (m.parallelizationFactor ? '<span>Parallel: <code>' + esc(m.parallelizationFactor) + '</code></span>' : '') +
            (m.maxRecordAgeSec ? '<span>Max age: <code>' + esc(m.maxRecordAgeSec) + 's</code></span>' : '') +
            (m.bisectBatchOnError ? '<span><code>bisect-on-error</code></span>' : '') +
            (m.tumblingWindowSec ? '<span>Tumbling: <code>' + esc(m.tumblingWindowSec) + 's</code></span>' : '') +
            '<span>UUID: <code>' + esc(m.uuid) + '</code></span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderFirehose(pack) {
      const items = pack.items || [];
      document.getElementById('cnt-firehose').textContent = String(items.length);
      document.getElementById('firehose-note').textContent = pack.scanned != null
        ? 'scanned ' + pack.scanned + ' delivery stream' + (pack.scanned === 1 ? '' : 's')
        : '';
      const body = document.getElementById('body-firehose');
      if (pack.error) { body.innerHTML = '<div class="err">' + esc(pack.error) + '</div>'; return; }
      if (items.length === 0) { body.innerHTML = '<div class="empty">No Firehose delivery streams read from this stream.</div>'; return; }
      body.innerHTML = items.map(function(f) {
        const destLines = (f.destinations || []).map(function(d) {
          const parts = [];
          if (d.extendedS3 || d.s3) parts.push('S3 → <code>' + esc(d.extendedS3 || d.s3) + '</code>');
          if (d.redshift) parts.push('Redshift → <code>' + esc(d.redshift) + '</code>');
          if (d.openSearch) parts.push('OpenSearch → <code>' + esc(d.openSearch) + '</code>');
          if (d.elasticsearch) parts.push('ES → <code>' + esc(d.elasticsearch) + '</code>');
          if (d.splunk) parts.push('Splunk → <code>' + esc(d.splunk) + '</code>');
          if (d.http) parts.push('HTTP → <code>' + esc(d.http) + '</code>');
          return parts.length ? '<div class="dest-line">' + parts.join(' · ') + '</div>' : '';
        }).join('');
        return '<div class="row">' +
          '<div class="r-title">' + esc(f.name) + '</div>' +
          '<div class="r-meta">' +
            '<span><span class="badge ' + esc(f.deliveryStreamStatus || '') + '">' + esc(f.deliveryStreamStatus || '') + '</span></span>' +
            '<span>Type: <code>' + esc(f.deliveryStreamType) + '</code></span>' +
            (f.roleArn ? '<span>Role: <code>' + esc(f.roleArn) + '</code></span>' : '') +
          '</div>' +
          destLines +
        '</div>';
      }).join('');
    }

    function renderConsumers(pack) {
      const items = pack.items || [];
      document.getElementById('cnt-consumers').textContent = String(items.length);
      const body = document.getElementById('body-consumers');
      if (pack.error) { body.innerHTML = '<div class="err">' + esc(pack.error) + '</div>'; return; }
      if (items.length === 0) { body.innerHTML = '<div class="empty">No enhanced fan-out consumers registered.</div>'; return; }
      body.innerHTML = items.map(function(c) {
        return '<div class="row">' +
          '<div class="r-title">' + esc(c.name) + '</div>' +
          '<div class="r-meta">' +
            '<span><span class="badge ' + esc(c.status || '') + '">' + esc(c.status || '') + '</span></span>' +
            '<span>Created: ' + esc(fmtTs(c.creationTs)) + '</span>' +
            '<span>ARN: <code>' + esc(c.arn) + '</code></span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (m.type === 'targets') {
        renderLambda(m.lambdaMappings);
        renderFirehose(m.firehoses);
        renderConsumers(m.consumers);
        document.getElementById('status').textContent = '';
      } else if (m.type === 'error') {
        document.getElementById('status').textContent = m.message;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
