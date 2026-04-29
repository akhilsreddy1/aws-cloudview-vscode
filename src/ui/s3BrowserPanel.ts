import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ListObjectsV2Command,
  HeadObjectCommand,
  type _Object,
  type CommonPrefix,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import {
  generateNonce,
  escapeHtml,
  buildCsp,
  BASE_STYLES,
  AWS_ICONS,
  DEFAULT_ICON,
} from "../views/webviewToolkit";

interface PrefixListing {
  /** Delimited sub-prefixes at the current level (shown as "folders"). */
  prefixes: string[];
  /** Total count of objects at or below the current prefix (from KeyCount or sum across pages). */
  objectCount: number;
  /** Total size in bytes of objects returned at this level (best-effort, first page only). */
  totalBytes: number;
  /** If the listing was truncated (count/size are partial). */
  truncated: boolean;
}

/**
 * A VS Code panel that allows browsing an S3 bucket by prefix ("folder") and uploading files into the current prefix.
 * It provides a lightweight, prefix-only navigation experience without listing individual objects, making it efficient for buckets with large numbers of objects.

 */
export class S3BrowserPanel {
  private static panels = new Map<string, S3BrowserPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly bucketName: string;
  private readonly bucketRegion: string;
  /** Current prefix including trailing "/". Empty string = bucket root. */
  private currentPrefix = "";
  /**
   * Currently-running upload, if any. Captured so that closing the panel
   * mid-upload can `.abort()` it — otherwise the `@aws-sdk/lib-storage`
   * `Upload` keeps running in the background, holding the file handle and
   * S3 multipart session open until it completes.
   */
  private currentUpload: Upload | undefined;
  /** Read stream for the in-flight upload, closed alongside the abort. */
  private currentUploadStream: fs.ReadStream | undefined;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.bucketName = resource.name || resource.id;
    this.bucketRegion =
      (resource.rawJson.BucketRegion as string | undefined) ?? "us-east-1";

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewS3Browser",
      `S3: ${this.bucketName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      this.abortInFlightUpload("panel closed");
      S3BrowserPanel.panels.delete(resource.arn);
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "navigate" && typeof msg.prefix === "string") {
          this.currentPrefix = msg.prefix;
          await this.loadListing();
        } else if (msg.type === "refresh") {
          await this.loadListing();
        } else if (msg.type === "upload") {
          await this.handleUpload();
        }
      } catch (err) {
        this.postError(err);
      }
    });

    this.panel.webview.html = this.buildHtml();
    void this.loadListing();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = S3BrowserPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new S3BrowserPanel(platform, resource);
    S3BrowserPanel.panels.set(resource.arn, instance);
  }

  // ── Listing ────────────────────────────────────────────────────────────────
  private async loadListing(): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(
      this.resource.accountId,
    );
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = {
      profileName,
      accountId: this.resource.accountId,
      region: this.resource.region,
    };
    const client = await this.platform.awsClientFactory.s3(scope, this.bucketRegion);

    // Single-page listing for prefix navigation. KeyCount on the first page is
    // enough to orient the user; we explicitly do NOT paginate to millions of
    // objects here (that's the whole point of a prefix-only browser).
    const response = await this.platform.scheduler.run("s3", "ListObjectsV2", () =>
      client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: this.currentPrefix || undefined,
          Delimiter: "/",
          MaxKeys: 1000,
        }),
      ),
    );

    const prefixes = (response.CommonPrefixes ?? [])
      .map((cp: CommonPrefix) => cp.Prefix ?? "")
      .filter(Boolean)
      .sort();

    const objects: _Object[] = response.Contents ?? [];
    // Exclude the "folder marker" (a zero-byte object whose key == the prefix
    // itself) that the S3 Console creates when you click "Create folder."
    const realObjects = objects.filter((o) => o.Key !== this.currentPrefix);

    const listing: PrefixListing = {
      prefixes,
      objectCount: realObjects.length,
      totalBytes: realObjects.reduce((sum, o) => sum + (o.Size ?? 0), 0),
      truncated: Boolean(response.IsTruncated),
    };

    void this.panel.webview.postMessage({
      type: "update",
      bucket: this.bucketName,
      region: this.bucketRegion,
      prefix: this.currentPrefix,
      listing,
    });
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  private async handleUpload(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "Upload to S3",
    });
    if (!picked || picked.length === 0) {
      return;
    }

    const filePath = picked[0].fsPath;
    const fileName = path.basename(filePath);
    const targetKey = (this.currentPrefix || "") + fileName;

    if (this.looksSensitive(fileName)) {
      const proceed = await vscode.window.showWarningMessage(
        `Upload "${fileName}" to s3://${this.bucketName}/${targetKey}?`,
        {
          modal: true,
          detail:
            "This filename looks like it might contain credentials or secrets. Double-check before uploading to a shared bucket.",
        },
        "Upload Anyway",
      );
      if (proceed !== "Upload Anyway") {
        return;
      }
    }

    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(
      this.resource.accountId,
    );
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = {
      profileName,
      accountId: this.resource.accountId,
      region: this.resource.region,
    };
    const client = await this.platform.awsClientFactory.s3(scope, this.bucketRegion);

    // Overwrite guard — HEAD the key, 404 means new upload.
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: targetKey }));
      const confirmed = await vscode.window.showWarningMessage(
        `Object "${targetKey}" already exists in ${this.bucketName}.`,
        { modal: true, detail: "Uploading will overwrite the existing object." },
        "Overwrite",
      );
      if (confirmed !== "Overwrite") {
        return;
      }
    } catch (err: unknown) {
      // 404 / NoSuchKey / NotFound is the expected "object doesn't exist" path.
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      const isMissing =
        status === 404 || name === "NotFound" || name === "NoSuchKey";
      if (!isMissing) {
        throw err;
      }
    }

    const stat = fs.statSync(filePath);
    const contentType = this.guessContentType(fileName);
    const stream = fs.createReadStream(filePath);

    this.postProgress({
      stage: "start",
      key: targetKey,
      fileName,
      totalBytes: stat.size,
      uploadedBytes: 0,
    });

    const uploader = new Upload({
      client,
      params: {
        Bucket: this.bucketName,
        Key: targetKey,
        Body: stream,
        ContentType: contentType,
      },
      // 5 MB parts — AWS minimum. Raise if we hit the 10k-part cap on
      // very-large files (>50 GB).
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });

    // Stash the handle so `onDidDispose` can cancel an in-flight upload
    // rather than leaking the file handle and multipart session.
    this.currentUpload = uploader;
    this.currentUploadStream = stream;

    uploader.on("httpUploadProgress", (p) => {
      this.postProgress({
        stage: "progress",
        key: targetKey,
        fileName,
        totalBytes: p.total ?? stat.size,
        uploadedBytes: p.loaded ?? 0,
      });
    });

    try {
      await uploader.done();
      this.postProgress({
        stage: "done",
        key: targetKey,
        fileName,
        totalBytes: stat.size,
        uploadedBytes: stat.size,
      });
      void vscode.window.setStatusBarMessage(`Uploaded ${fileName} to s3://${this.bucketName}`, 3000);
      await this.loadListing();
    } catch (err) {
      this.postProgress({
        stage: "error",
        key: targetKey,
        fileName,
        totalBytes: stat.size,
        uploadedBytes: 0,
      });
      throw err;
    } finally {
      this.currentUpload = undefined;
      this.currentUploadStream = undefined;
    }
  }

  /**
   * Cancel the in-flight upload, if any. Aborts the multipart session on
   * S3 (no orphan parts left behind after a few days) and closes the
   * local read stream so the file handle is released immediately. Safe
   * to call when no upload is running.
   */
  private abortInFlightUpload(reason: string): void {
    const uploader = this.currentUpload;
    const stream = this.currentUploadStream;
    if (!uploader && !stream) return;
    this.currentUpload = undefined;
    this.currentUploadStream = undefined;
    try {
      stream?.destroy();
    } catch {
      // Destroying an already-closed stream throws synchronously on some
      // Node versions — harmless at shutdown.
    }
    // `Upload.abort()` returns a promise that resolves once AbortMultipartUpload
    // has been sent. We deliberately don't await it: we're already tearing down
    // the panel and can't surface errors anywhere useful. Log for diagnosability.
    uploader?.abort().catch((err) => {
      this.platform.logger.warn(
        `Failed to abort S3 upload (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private looksSensitive(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    const risky = [".env", ".pem", ".key", ".ppk", "id_rsa", "id_dsa", "credentials", ".pfx"];
    return risky.some((r) => lower.endsWith(r) || lower.includes(r));
  }

  private guessContentType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      ".json": "application/json",
      ".txt": "text/plain",
      ".log": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".html": "text/html",
      ".js": "text/javascript",
      ".ts": "text/typescript",
      ".xml": "application/xml",
      ".yaml": "application/x-yaml",
      ".yml": "application/x-yaml",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".gz": "application/gzip",
      ".tar": "application/x-tar",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
    };
    return map[ext] ?? "application/octet-stream";
  }

  private postProgress(payload: {
    stage: "start" | "progress" | "done" | "error";
    key: string;
    fileName: string;
    totalBytes: number;
    uploadedBytes: number;
  }): void {
    void this.panel.webview.postMessage({ type: "progress", ...payload });
  }

  private postError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    void this.panel.webview.postMessage({ type: "error", error: message });
  }

  // ── HTML ───────────────────────────────────────────────────────────────────
  private buildHtml(): string {
    const n = generateNonce();
    const icon = AWS_ICONS["s3"] || DEFAULT_ICON;
    const bucket = escapeHtml(this.bucketName);
    const region = escapeHtml(this.bucketRegion);
    const accountId = escapeHtml(this.resource.accountId);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>S3: ${bucket}</title>
<style>
${BASE_STYLES}
.s3-crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; margin: 4px 0 12px; }
.s3-crumb {
  padding: 3px 10px; border-radius: var(--radius-sm); border:1px solid var(--border);
  background: var(--surface-2); cursor:pointer; font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 12px; color: var(--foreground); transition: all .12s;
}
.s3-crumb:hover { background: var(--accent-soft); border-color: var(--accent); }
.s3-crumb-sep { color: var(--muted); user-select: none; }
.s3-crumb-current {
  background: var(--accent-soft); border-color: var(--accent); color: var(--accent);
  font-weight: 600; cursor: default;
}
.s3-row {
  display:flex; align-items:center; gap:10px;
  padding: 9px 12px; border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background .08s;
}
.s3-row:hover { background: var(--surface-2); }
.s3-row-icon { font-size: 16px; opacity: .7; }
.s3-row-name { font-family: ui-monospace, 'SF Mono', monospace; font-size: 13px; }
.s3-upload-btn {
  display:inline-flex; align-items:center; gap:6px;
  padding: 6px 14px; border: 1px solid var(--accent); background: var(--accent);
  color: #fff; border-radius: var(--radius-sm); font-family: inherit;
  font-size: 12px; font-weight: 600; cursor: pointer; transition: all .12s;
}
.s3-upload-btn:hover { filter: brightness(1.08); }
.s3-upload-btn:disabled { opacity: .5; cursor: not-allowed; }
.s3-progress {
  margin-top: 8px; padding: 10px 14px; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 12px; display:none;
}
.s3-progress-bar-track {
  height: 6px; background: var(--border); border-radius: 99px;
  overflow: hidden; margin-top: 6px;
}
.s3-progress-bar-fill {
  height: 100%; background: var(--accent); border-radius: 99px;
  transition: width .15s linear;
}
.s3-progress-error { color: #b91c1c; }
.s3-progress-done  { color: #047857; }
.s3-warn {
  margin-top: 8px; padding: 8px 12px; background:#fffbeb;
  border:1px solid #fde68a; border-radius: var(--radius-sm);
  font-size: 12px; color:#78350f;
}
</style>
</head>
<body>
<div class="cv-header">
  <div class="cv-header-top">
    <div class="cv-service-icon">${icon}</div>
    <div class="cv-title-group">
      <div class="cv-service-title">${bucket}</div>
      <div class="cv-service-subtitle">
        <span>Amazon S3</span>
        <span class="cv-sep">\u2022</span>
        <span>${accountId}</span>
        <span class="cv-sep">\u2022</span>
        <span>${region}</span>
      </div>
    </div>
    <div class="cv-header-actions">
      <button class="cv-btn" id="refresh" title="Refresh">&#8635; Refresh</button>
      <button class="s3-upload-btn" id="upload" title="Upload a file to the current prefix">&#8682; Upload File</button>
    </div>
  </div>
  <div class="s3-crumbs" id="crumbs"></div>
  <div class="cv-stats" id="stats"></div>
  <div class="s3-progress" id="progress"></div>
</div>
<div class="cv-table-wrap">
  <div id="content" class="cv-empty"><span class="cv-empty-icon">\u2026</span>Loading prefixes\u2026</div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let state = { bucket: '', prefix: '', listing: null };

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('upload').addEventListener('click', () => vscode.postMessage({ type: 'upload' }));

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'update') {
    state = { bucket: m.bucket, prefix: m.prefix, listing: m.listing };
    renderAll();
  } else if (m.type === 'progress') {
    renderProgress(m);
  } else if (m.type === 'error') {
    showError(m.error);
  }
});

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function renderAll() {
  renderCrumbs();
  renderStats();
  renderPrefixes();
}

function renderCrumbs() {
  const el = document.getElementById('crumbs');
  const segs = state.prefix ? state.prefix.replace(/\\/$/, '').split('/') : [];
  const parts = [];
  parts.push(crumbHtml(state.bucket, '', segs.length === 0));
  let built = '';
  segs.forEach((seg, i) => {
    built += seg + '/';
    parts.push('<span class="s3-crumb-sep">/</span>');
    parts.push(crumbHtml(seg, built, i === segs.length - 1));
  });
  el.innerHTML = parts.join('');
  el.querySelectorAll('button.s3-crumb').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-prefix') || '';
      if (target === state.prefix) return;
      vscode.postMessage({ type: 'navigate', prefix: target });
    });
  });
}

function crumbHtml(label, prefix, current) {
  const cls = 's3-crumb' + (current ? ' s3-crumb-current' : '');
  return '<button class="' + cls + '" data-prefix="' + escape(prefix) + '">' + escape(label) + '</button>';
}

function renderStats() {
  const el = document.getElementById('stats');
  if (!state.listing) { el.innerHTML = ''; return; }
  const sub = state.listing.prefixes.length;
  const objs = state.listing.objectCount;
  const size = fmtBytes(state.listing.totalBytes);
  const truncSuffix = state.listing.truncated ? '+' : '';
  const stats = [
    { label: 'Sub-prefixes', value: String(sub) },
    { label: 'Objects at this level', value: String(objs) + truncSuffix },
    { label: 'Size at this level', value: size + truncSuffix },
  ];
  el.innerHTML = stats.map(s =>
    '<div class="cv-stat-card" style="--stat-accent:#7AA116">' +
      '<div class="cv-stat-value">' + escape(s.value) + '</div>' +
      '<div class="cv-stat-label">' + escape(s.label) + '</div>' +
    '</div>'
  ).join('');
}

function renderPrefixes() {
  const el = document.getElementById('content');
  if (!state.listing) return;
  if (state.listing.prefixes.length === 0) {
    el.className = 'cv-empty';
    const hint = state.prefix
      ? 'No sub-prefixes here. Use Upload to add a file at this level.'
      : 'This bucket has no top-level prefixes. Use Upload to add a file at the root.';
    el.innerHTML = '<span class="cv-empty-icon">\uD83D\uDCC1</span>' +
      '<div>No sub-prefixes.</div>' +
      '<div class="cv-empty-hint">' + escape(hint) + '</div>';
    return;
  }
  el.className = '';
  let html = '<div>';
  for (const p of state.listing.prefixes) {
    const display = p.substring(state.prefix.length).replace(/\\/$/, '');
    html += '<div class="s3-row" data-prefix="' + escape(p) + '">' +
      '<span class="s3-row-icon">\uD83D\uDCC1</span>' +
      '<span class="s3-row-name">' + escape(display) + '/</span>' +
    '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('.s3-row').forEach(row => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'navigate', prefix: row.getAttribute('data-prefix') });
    });
  });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024*1024)).toFixed(1) + ' MB';
  return (n / (1024*1024*1024)).toFixed(2) + ' GB';
}

function renderProgress(m) {
  const el = document.getElementById('progress');
  el.style.display = 'block';
  el.classList.remove('s3-progress-error', 's3-progress-done');

  if (m.stage === 'error') {
    el.classList.add('s3-progress-error');
    el.innerHTML = '<strong>Upload failed</strong> \u2014 ' + escape(m.fileName);
    return;
  }

  const pct = m.totalBytes ? Math.min(100, Math.round((m.uploadedBytes / m.totalBytes) * 100)) : 0;
  const loaded = fmtBytes(m.uploadedBytes);
  const total = fmtBytes(m.totalBytes);
  const label = m.stage === 'done'
    ? 'Uploaded ' + escape(m.fileName) + ' \u2713'
    : 'Uploading ' + escape(m.fileName) + ' \u2014 ' + pct + '% (' + loaded + ' / ' + total + ')';
  if (m.stage === 'done') { el.classList.add('s3-progress-done'); }
  el.innerHTML = '<div>' + label + '</div>' +
    '<div class="s3-progress-bar-track"><div class="s3-progress-bar-fill" style="width:' + pct + '%"></div></div>';

  if (m.stage === 'done') {
    setTimeout(() => { el.style.display = 'none'; }, 2500);
  }
}

function showError(msg) {
  const el = document.getElementById('content');
  el.className = 'cv-empty';
  el.innerHTML = '<span class="cv-empty-icon" style="color:#b91c1c">\u26A0</span>' +
    '<div style="color:#b91c1c">' + escape(msg) + '</div>' +
    '<div class="cv-empty-hint">Click Refresh to try again.</div>';
}
</script>
</body>
</html>`;
  }
}
