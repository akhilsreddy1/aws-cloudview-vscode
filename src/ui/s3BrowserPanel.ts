import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  type _Object,
  type CommonPrefix,
} from "@aws-sdk/client-s3";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
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

/** A single object shown in the per-prefix preview list. */
interface ObjectEntry {
  /** Full S3 key. */
  key: string;
  /** Display name (key with the current prefix stripped). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified ISO timestamp, if available. */
  lastModified?: string;
}

/** How many objects we preview per prefix. The whole point is a quick peek,
 * not a full file manager — buckets can hold millions of keys. */
const OBJECT_PREVIEW_LIMIT = 10;

interface PrefixListing {
  /** Delimited sub-prefixes at the current level (shown as "folders"). */
  prefixes: string[];
  /** First {@link OBJECT_PREVIEW_LIMIT} objects directly at this prefix. */
  objects: ObjectEntry[];
  /** Total count of objects at or below the current prefix (from KeyCount or sum across pages). */
  objectCount: number;
  /** Total size in bytes of objects returned at this level (best-effort, first page only). */
  totalBytes: number;
  /** If the listing was truncated (count/size are partial). */
  truncated: boolean;
  /** True when there are more objects at this prefix than we previewed. */
  moreObjects: boolean;
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
        if (msg.type === "expandPrefix" && typeof msg.prefix === "string") {
          await this.loadPrefixListing(msg.prefix);
        } else if (msg.type === "refresh") {
          void this.panel.webview.postMessage({ type: "resetTree" });
          await this.loadPrefixListing("");
        } else if (msg.type === "upload") {
          this.currentPrefix = typeof msg.prefix === "string" ? msg.prefix : "";
          await this.handleUpload();
        } else if (msg.type === "download" && typeof msg.key === "string") {
          await this.handleDownload(msg.key, typeof msg.name === "string" ? msg.name : undefined);
        }
      } catch (err) {
        this.postError(err);
      }
    });

    this.panel.webview.html = this.buildHtml();
    void this.loadPrefixListing("");
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
  private async loadPrefixListing(prefix: string): Promise<void> {
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

    const response = await this.platform.scheduler.run("s3", "ListObjectsV2", () =>
      client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix || undefined,
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
    const realObjects = objects.filter((o) => o.Key !== prefix);

    const sortedByRecent = [...realObjects].sort((a, b) => {
      const ta = a.LastModified ? a.LastModified.getTime() : 0;
      const tb = b.LastModified ? b.LastModified.getTime() : 0;
      return tb - ta;
    });
    const previewObjects: ObjectEntry[] = sortedByRecent
      .slice(0, OBJECT_PREVIEW_LIMIT)
      .map((o) => ({
        key: o.Key ?? "",
        name: (o.Key ?? "").substring(prefix.length),
        size: o.Size ?? 0,
        lastModified: o.LastModified ? o.LastModified.toISOString() : undefined,
      }));

    const listing: PrefixListing = {
      prefixes,
      objects: previewObjects,
      objectCount: realObjects.length,
      totalBytes: realObjects.reduce((sum, o) => sum + (o.Size ?? 0), 0),
      truncated: Boolean(response.IsTruncated),
      moreObjects: realObjects.length > OBJECT_PREVIEW_LIMIT || Boolean(response.IsTruncated),
    };

    void this.panel.webview.postMessage({
      type: "prefixData",
      bucket: this.bucketName,
      region: this.bucketRegion,
      prefix,
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
      await this.loadPrefixListing(this.currentPrefix);
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

  // ── Download ─────────────────────────────────────────────────────────────
  /**
   * Stream an object from S3 to a user-chosen local path. We prompt with a
   * Save dialog defaulted to the object's base name, then pipe the
   * `GetObject` body stream straight to disk — no buffering the whole object
   * in memory, so large files are fine.
   */
  private async handleDownload(key: string, displayName?: string): Promise<void> {
    const baseName = displayName || key.split("/").pop() || "download";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(getDefaultDownloadDir(), baseName)),
      saveLabel: "Download from S3",
    });
    if (!target) return; // user cancelled

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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${baseName} from S3…`,
        cancellable: false,
      },
      async () => {
        const resp = await this.platform.scheduler.run("s3", "GetObject", () =>
          client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }))
        );
        const body = resp.Body as Readable | undefined;
        if (!body) {
          throw new Error(`Empty response body for s3://${this.bucketName}/${key}`);
        }
        // Stream straight to disk so we never hold the whole object in memory.
        await pipeline(body, fs.createWriteStream(target.fsPath));
      },
    ).then(
      () => {
        void vscode.window
          .showInformationMessage(`Downloaded ${baseName}`, "Open File", "Reveal in Finder")
          .then((action) => {
            if (action === "Open File") {
              void vscode.commands.executeCommand("vscode.open", target);
            } else if (action === "Reveal in Finder") {
              void vscode.commands.executeCommand("revealFileInOS", target);
            }
          });
      },
      (err: unknown) => {
        this.postError(err instanceof Error ? err : new Error(String(err)));
      },
    );
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

/* ── Tree view ── */
.s3-tree { padding: 2px 0; }
.s3-tree-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 14px 4px 0; cursor: pointer;
  transition: background .08s; user-select: none;
  border-radius: 4px; margin: 0 4px;
}
.s3-tree-item:hover { background: var(--surface-2); }
.s3-tree-item.s3-selected {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}
.s3-tree-chevron {
  width: 18px; height: 18px; display: inline-flex; align-items: center;
  justify-content: center; flex-shrink: 0; border-radius: 4px;
  color: var(--muted); font-size: 10px; transition: all .12s;
}
.s3-tree-item:hover .s3-tree-chevron { color: var(--text); background: var(--surface-3); }
.s3-tree-chevron-spacer { width: 18px; flex-shrink: 0; }
@keyframes s3-spin { to { transform: rotate(360deg); } }
.s3-tree-spinner { animation: s3-spin .8s linear infinite; }
.s3-tree-icon { font-size: 15px; flex-shrink: 0; line-height: 1; }
.s3-tree-name {
  font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text);
}
.s3-tree-folder .s3-tree-name { font-weight: 600; }
.s3-tree-object .s3-tree-name { font-weight: 400; color: var(--text-2); }
.s3-tree-object { cursor: default; }
.s3-tree-meta {
  margin-left: auto; display: flex; align-items: center; gap: 8px;
  flex-shrink: 0;
}
.s3-tree-size {
  font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
  font-family: ui-monospace, 'SF Mono', monospace;
}
.s3-tree-date { font-size: 10px; color: var(--light); white-space: nowrap; }
.s3-tree-count {
  font-size: 10px; color: var(--light); font-weight: 500;
  background: var(--surface-3); padding: 1px 6px; border-radius: 99px;
}
.s3-tree-children { /* nesting container — animated */ }
.s3-tree-more {
  font-size: 11px; color: var(--muted); font-style: italic;
  padding: 3px 14px 3px 0;
}
.s3-tree-guide {
  position: relative;
}
.s3-tree-guide::before {
  content: ''; position: absolute; left: -1px; top: 0; bottom: 0;
  width: 1px; background: var(--border);
}
.s3-dl-btn {
  padding: 2px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); background: transparent; color: var(--text-2);
  font-size: 10px; font-weight: 600; cursor: pointer; white-space: nowrap;
  opacity: 0; transition: all .12s; font-family: inherit;
}
.s3-tree-item:hover .s3-dl-btn { opacity: 1; }
.s3-dl-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

/* ── Upload button ── */
.s3-upload-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border: 1px solid var(--accent); background: var(--accent);
  color: #fff; border-radius: var(--radius-sm); font-family: inherit;
  font-size: 12px; font-weight: 600; cursor: pointer; transition: all .12s;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.s3-upload-btn:hover { filter: brightness(1.08); }
.s3-upload-btn:disabled { opacity: .5; cursor: not-allowed; }

/* ── Upload target indicator ── */
.s3-upload-target {
  font-size: 11px; color: var(--muted); margin: 6px 0 0;
  font-family: ui-monospace, 'SF Mono', monospace;
}
.s3-upload-target strong { color: var(--accent); font-weight: 600; }

/* ── Progress ── */
.s3-progress {
  margin-top: 8px; padding: 10px 14px; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 12px; display: none;
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
      <button class="s3-upload-btn" id="upload" title="Upload a file to the bucket root">&#8682; Upload File</button>
    </div>
  </div>
  <div class="cv-stats" id="stats"></div>
  <div id="uploadTarget" class="s3-upload-target" style="display:none"></div>
  <div class="s3-progress" id="progress"></div>
</div>
<div class="cv-table-wrap">
  <div id="content" class="cv-empty"><span class="cv-empty-icon">\u2026</span>Loading\u2026</div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();

/* ── Tree state ── */
const treeData = {};
let selectedPrefix = '';

document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('upload').addEventListener('click', () => {
  vscode.postMessage({ type: 'upload', prefix: selectedPrefix });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'prefixData') {
    if (!treeData[m.prefix]) treeData[m.prefix] = {};
    treeData[m.prefix].listing = m.listing;
    treeData[m.prefix].loaded = true;
    treeData[m.prefix].loading = false;
    if (treeData[m.prefix].expanded === undefined) treeData[m.prefix].expanded = true;
    renderTree();
    if (m.prefix === '') renderStats();
  } else if (m.type === 'resetTree') {
    for (const k of Object.keys(treeData)) delete treeData[k];
    selectedPrefix = '';
    updateUploadTarget();
  } else if (m.type === 'progress') {
    renderProgress(m);
  } else if (m.type === 'error') {
    showError(m.error);
  }
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'": '&#39;' })[c]);
}

/* ── Stats ── */
function renderStats() {
  const el = document.getElementById('stats');
  const root = treeData[''];
  if (!root || !root.listing) { el.innerHTML = ''; return; }
  const l = root.listing;
  const stats = [
    { label: 'Folders', value: String(l.prefixes.length) },
    { label: 'Root objects', value: String(l.objectCount) + (l.truncated ? '+' : '') },
    { label: 'Root size', value: fmtBytes(l.totalBytes) + (l.truncated ? '+' : '') },
  ];
  el.innerHTML = stats.map(s =>
    '<div class="cv-stat-card" style="--stat-accent:#7AA116">' +
      '<div class="cv-stat-value">' + esc(s.value) + '</div>' +
      '<div class="cv-stat-label">' + esc(s.label) + '</div>' +
    '</div>'
  ).join('');
}

/* ── Tree rendering ── */
function renderTree() {
  const el = document.getElementById('content');
  const root = treeData[''];
  if (!root || !root.listing) return;

  const l = root.listing;
  if (l.prefixes.length === 0 && l.objects.length === 0) {
    el.className = 'cv-empty';
    el.innerHTML = '<span class="cv-empty-icon">\uD83D\uDCC1</span>' +
      '<div>Empty bucket.</div>' +
      '<div class="cv-empty-hint">Use Upload to add files.</div>';
    return;
  }

  el.className = '';
  el.innerHTML = '<div class="s3-tree">' + renderLevel('', l, 0) + '</div>';
  bindTreeEvents(el);
}

function renderLevel(prefix, listing, depth) {
  let html = '';
  const pad = depth * 20 + 10;

  for (const p of (listing.prefixes || [])) {
    const display = p.substring(prefix.length).replace(/\\/$/, '');
    const d = treeData[p];
    const expanded = d && d.expanded;
    const loading = d && d.loading;
    const loaded = d && d.loaded;
    const isSel = selectedPrefix === p;

    const chevronCls = loading ? 's3-tree-chevron s3-tree-spinner' : 's3-tree-chevron';
    const chevronChar = loading ? '\u21BB' : (expanded ? '\u25BE' : '\u25B8');

    html += '<div class="s3-tree-item s3-tree-folder' + (isSel ? ' s3-selected' : '') +
      '" data-prefix="' + esc(p) + '" style="padding-left:' + pad + 'px">' +
      '<span class="' + chevronCls + '">' + chevronChar + '</span>' +
      '<span class="s3-tree-icon">\uD83D\uDCC1</span>' +
      '<span class="s3-tree-name">' + esc(display) + '/</span>';

    if (loaded && d.listing) {
      const cnt = (d.listing.prefixes || []).length + d.listing.objectCount;
      if (cnt > 0) html += '<span class="s3-tree-count">' + cnt + '</span>';
    }

    html += '</div>';

    if (expanded && loaded && d.listing) {
      html += renderLevel(p, d.listing, depth + 1);
    }
  }

  for (const o of (listing.objects || [])) {
    const ext = (o.name.split('.').pop() || '').toLowerCase();
    const icon = fileIcon(ext);

    html += '<div class="s3-tree-item s3-tree-object" style="padding-left:' + (pad + 20) + 'px">' +
      '<span class="s3-tree-icon">' + icon + '</span>' +
      '<span class="s3-tree-name">' + esc(o.name) + '</span>' +
      '<span class="s3-tree-meta">' +
        (o.lastModified ? '<span class="s3-tree-date">' + relDate(o.lastModified) + '</span>' : '') +
        '<span class="s3-tree-size">' + fmtBytes(o.size) + '</span>' +
        '<button class="s3-dl-btn" data-key="' + esc(o.key) + '" data-name="' + esc(o.name) +
          '" title="Download">\u2193</button>' +
      '</span>' +
    '</div>';
  }

  if (listing.moreObjects) {
    html += '<div class="s3-tree-more" style="padding-left:' + (pad + 20) + 'px">' +
      listing.objects.length + ' most-recent of ' + listing.objectCount +
      (listing.truncated ? '+' : '') + ' objects shown (newest first)\u2026</div>';
  }

  return html;
}

function fileIcon(ext) {
  var m = {
    json:'\uD83D\uDCCB', csv:'\uD83D\uDCCA', txt:'\uD83D\uDCDD', log:'\uD83D\uDCDD', md:'\uD83D\uDCDD',
    js:'\u26A1', ts:'\u26A1', py:'\uD83D\uDC0D', html:'\uD83C\uDF10', css:'\uD83C\uDFA8',
    jpg:'\uD83D\uDDBC', jpeg:'\uD83D\uDDBC', png:'\uD83D\uDDBC', gif:'\uD83D\uDDBC',
    svg:'\uD83D\uDDBC', webp:'\uD83D\uDDBC',
    pdf:'\uD83D\uDCD5', zip:'\uD83D\uDCE6', gz:'\uD83D\uDCE6', tar:'\uD83D\uDCE6',
    mp4:'\uD83C\uDFAC', mp3:'\uD83C\uDFB5',
    xml:'\uD83D\uDCC4', yaml:'\uD83D\uDCC4', yml:'\uD83D\uDCC4',
    parquet:'\uD83D\uDDC3', avro:'\uD83D\uDDC3',
  };
  return m[ext] || '\uD83D\uDCC4';
}

function relDate(iso) {
  var d = new Date(iso), now = new Date(), diff = (now - d) / 1000;
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff/86400) + 'd ago';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

/* ── Event binding ── */
function bindTreeEvents(container) {
  container.querySelectorAll('.s3-tree-folder').forEach(function(row) {
    row.addEventListener('click', function(ev) {
      if (ev.target.closest('.s3-dl-btn')) return;
      var prefix = row.getAttribute('data-prefix');

      selectedPrefix = prefix;
      updateUploadTarget();

      if (!treeData[prefix]) {
        treeData[prefix] = { expanded: true, loaded: false, loading: true };
        vscode.postMessage({ type: 'expandPrefix', prefix: prefix });
        renderTree();
        return;
      }
      if (!treeData[prefix].loaded) {
        treeData[prefix].loading = true;
        treeData[prefix].expanded = true;
        vscode.postMessage({ type: 'expandPrefix', prefix: prefix });
        renderTree();
        return;
      }
      treeData[prefix].expanded = !treeData[prefix].expanded;
      renderTree();
    });
  });

  container.querySelectorAll('.s3-dl-btn').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      vscode.postMessage({
        type: 'download',
        key: btn.getAttribute('data-key'),
        name: btn.getAttribute('data-name'),
      });
    });
  });
}

/* ── Upload target ── */
function updateUploadTarget() {
  var el = document.getElementById('uploadTarget');
  var btn = document.getElementById('upload');
  if (selectedPrefix) {
    el.style.display = 'block';
    el.innerHTML = 'Upload target: <strong>/' + esc(selectedPrefix) + '</strong>';
    btn.title = 'Upload to ' + selectedPrefix;
  } else {
    el.style.display = 'none';
    btn.title = 'Upload a file to the bucket root';
  }
}

/* ── Utilities ── */
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024*1024)).toFixed(1) + ' MB';
  return (n / (1024*1024*1024)).toFixed(2) + ' GB';
}

function renderProgress(m) {
  var el = document.getElementById('progress');
  el.style.display = 'block';
  el.classList.remove('s3-progress-error', 's3-progress-done');

  if (m.stage === 'error') {
    el.classList.add('s3-progress-error');
    el.innerHTML = '<strong>Upload failed</strong> \u2014 ' + esc(m.fileName);
    return;
  }

  var pct = m.totalBytes ? Math.min(100, Math.round((m.uploadedBytes / m.totalBytes) * 100)) : 0;
  var loaded = fmtBytes(m.uploadedBytes);
  var total = fmtBytes(m.totalBytes);
  var label = m.stage === 'done'
    ? 'Uploaded ' + esc(m.fileName) + ' \u2713'
    : 'Uploading ' + esc(m.fileName) + ' \u2014 ' + pct + '% (' + loaded + ' / ' + total + ')';
  if (m.stage === 'done') el.classList.add('s3-progress-done');
  el.innerHTML = '<div>' + label + '</div>' +
    '<div class="s3-progress-bar-track"><div class="s3-progress-bar-fill" style="width:' + pct + '%"></div></div>';

  if (m.stage === 'done') {
    setTimeout(function() { el.style.display = 'none'; }, 2500);
  }
}

function showError(msg) {
  var el = document.getElementById('content');
  el.className = 'cv-empty';
  el.innerHTML = '<span class="cv-empty-icon" style="color:#b91c1c">\u26A0</span>' +
    '<div style="color:#b91c1c">' + esc(msg) + '</div>' +
    '<div class="cv-empty-hint">Click Refresh to try again.</div>';
}
</script>
</body>
</html>`;
  }
}

/**
 * Default directory the Save dialog opens to. Prefers the OS Downloads
 * folder, falling back to the home directory. Kept module-level so it's
 * easy to test/override later.
 */
function getDefaultDownloadDir(): string {
  const home = require("node:os").homedir();
  const downloads = path.join(home, "Downloads");
  try {
    if (fs.existsSync(downloads) && fs.statSync(downloads).isDirectory()) {
      return downloads;
    }
  } catch {
    // fall through to home
  }
  return home;
}
