import * as vscode from "vscode";
import {
  DescribeImagesCommand,
  BatchDeleteImageCommand,
  type ImageDetail,
  type ImageIdentifier,
} from "@aws-sdk/client-ecr";
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

interface ImageRow {
  digest: string;
  tags: string[];
  pushedAt?: number;
  sizeMB?: number;
}

/**
 * Panel listing the images in an ECR repository, with the ability to delete
 * individual tags or an entire image (by digest).
 *
 * - Deleting a tag calls `BatchDeleteImage` with `imageTag` — the image is
 *   untagged; AWS removes the underlying layers only when no tags reference
 *   them anymore.
 * - Deleting an image calls `BatchDeleteImage` with `imageDigest` — this
 *   removes all tags and the image itself immediately.
 *
 * Both operations are guarded by a modal confirmation.
 */
export class EcrImagesPanel {
  private static panels = new Map<string, EcrImagesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly repositoryName: string;
  private rows: ImageRow[] = [];

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.repositoryName = (resource.rawJson.repositoryName as string) ?? resource.name ?? resource.id;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewEcrImages",
      `ECR: ${this.repositoryName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => EcrImagesPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "refresh") {
          await this.loadImages();
        } else if (msg.type === "deleteTag" && typeof msg.tag === "string") {
          await this.deleteTag(msg.tag);
        } else if (msg.type === "deleteImage" && typeof msg.digest === "string") {
          await this.deleteImageByDigest(msg.digest);
        }
      } catch (err) {
        this.postError(err);
      }
    });

    this.panel.webview.html = this.buildHtml();
    void this.loadImages();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = EcrImagesPanel.panels.get(resource.arn);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new EcrImagesPanel(platform, resource);
    EcrImagesPanel.panels.set(resource.arn, instance);
  }

  private async loadImages(): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.ecr(scope);

    const all: ImageDetail[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.platform.scheduler.run("ecr", "DescribeImages", () =>
        client.send(
          new DescribeImagesCommand({
            repositoryName: this.repositoryName,
            nextToken,
            maxResults: 100,
          })
        )
      );
      all.push(...(response.imageDetails ?? []));
      nextToken = response.nextToken;
    } while (nextToken && all.length < 500);

    this.rows = all
      .map((img) => ({
        digest: img.imageDigest ?? "",
        tags: img.imageTags ?? [],
        pushedAt: img.imagePushedAt?.getTime(),
        sizeMB: typeof img.imageSizeInBytes === "number"
          ? Math.round((img.imageSizeInBytes / (1024 * 1024)) * 10) / 10
          : undefined,
      }))
      .sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));

    void this.panel.webview.postMessage({
      type: "update",
      rows: this.rows,
      stats: this.computeStats(this.rows),
    });
  }

  private computeStats(rows: ImageRow[]): Array<{ label: string; value: string }> {
    const totalTags = rows.reduce((sum, r) => sum + r.tags.length, 0);
    const untagged = rows.filter((r) => r.tags.length === 0).length;
    const totalMB = rows.reduce((sum, r) => sum + (r.sizeMB ?? 0), 0);
    const sizeLabel = totalMB >= 1024
      ? `${(totalMB / 1024).toFixed(2)} GB`
      : `${totalMB.toFixed(1)} MB`;
    return [
      { label: "Images", value: String(rows.length) },
      { label: "Tags", value: String(totalTags) },
      { label: "Untagged", value: String(untagged) },
      { label: "Total Size", value: sizeLabel },
    ];
  }

  private async deleteTag(tag: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete image tag "${tag}" from ${this.repositoryName}?`,
      { modal: true, detail: "This untags the image. Underlying layers are removed once no tags reference them." },
      "Delete"
    );
    if (confirm !== "Delete") { return; }

    await this.runBatchDelete([{ imageTag: tag }], `tag ${tag}`);
  }

  private async deleteImageByDigest(digest: string): Promise<void> {
    const row = this.rows.find((r) => r.digest === digest);
    const tagPreview = row && row.tags.length > 0
      ? `Tags: ${row.tags.join(", ")}`
      : "Untagged image";
    const shortDigest = digest.slice(0, 20) + "…";

    const confirm = await vscode.window.showWarningMessage(
      `Delete image ${shortDigest} from ${this.repositoryName}?`,
      {
        modal: true,
        detail: `${tagPreview}\n\nThis permanently removes the image and all its tags. Underlying layers are garbage-collected by ECR.`,
      },
      "Delete Image"
    );
    if (confirm !== "Delete Image") { return; }

    await this.runBatchDelete([{ imageDigest: digest }], `image ${shortDigest}`);
  }

  private async runBatchDelete(imageIds: ImageIdentifier[], label: string): Promise<void> {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) {
      this.postError(new Error("No AWS profile found for this account."));
      return;
    }

    const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
    const client = await this.platform.awsClientFactory.ecr(scope);

    const response = await this.platform.scheduler.run("ecr", "BatchDeleteImage", () =>
      client.send(new BatchDeleteImageCommand({ repositoryName: this.repositoryName, imageIds }))
    );

    const failure = (response.failures ?? [])[0];
    if (failure) {
      this.postError(new Error(`${failure.failureCode}: ${failure.failureReason}`));
      return;
    }

    void vscode.window.setStatusBarMessage(`Deleted ${label}`, 2500);
    await this.loadImages();
  }

  private postError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    void this.panel.webview.postMessage({ type: "error", error: message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const icon = AWS_ICONS["ecr"] || DEFAULT_ICON;
    const repoName = escapeHtml(this.repositoryName);
    const accountId = escapeHtml(this.resource.accountId);
    const region = escapeHtml(this.resource.region);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>ECR: ${repoName}</title>
<style>
${BASE_STYLES}
/* ── ECR image panel overrides ── */
.ecr-tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 4px 2px 9px; margin: 2px 4px 2px 0;
  border-radius: 99px; font-size: 10.5px; font-weight: 600; line-height: 1.5;
  background: var(--accent-soft); color: #c2410c;
  border: 1px solid #fed7aa; letter-spacing: .02em;
  font-family: ui-monospace, 'SF Mono', monospace;
}
.ecr-tag-untagged {
  background: #f1f5f9; color: #64748b; border-color: #e2e8f0;
  padding: 2px 9px; font-family: inherit; font-style: italic;
}
.ecr-tag-x {
  background: transparent; border: none; color: inherit;
  width: 16px; height: 16px; border-radius: 99px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 13px; line-height: 1;
  opacity: .55; transition: all .12s; font-family: inherit; padding: 0;
}
.ecr-tag-x:hover { opacity: 1; background: #fee2e2; color: #b91c1c; }
.ecr-digest {
  font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px;
  color: var(--muted); background: var(--surface-2);
  padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border);
}
.ecr-delete-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border: 1px solid #fecaca; color: #b91c1c;
  background: transparent; border-radius: var(--radius-sm);
  font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600;
  transition: all .12s;
}
.ecr-delete-btn:hover { background: #fef2f2; border-color: #b91c1c; }
.ecr-delete-btn:active { transform: scale(.97); }
.cv-table tbody td.ecr-col-actions { text-align: right; white-space: nowrap; }
.cv-table tbody td.ecr-col-tags { white-space: normal; max-width: 380px; }
.cv-table tbody tr { cursor: default; }
.cv-table tbody tr:hover { background: var(--surface-2); }
</style>
</head>
<body>
<div class="cv-header">
  <div class="cv-header-top">
    <div class="cv-service-icon">${icon}</div>
    <div class="cv-title-group">
      <div class="cv-service-title">${repoName}</div>
      <div class="cv-service-subtitle">
        <span>Amazon ECR</span>
        <span class="cv-sep">\u2022</span>
        <span>${accountId}</span>
        <span class="cv-sep">\u2022</span>
        <span>${region}</span>
      </div>
    </div>
    <div class="cv-header-actions">
      <button class="cv-btn" id="refresh" title="Refresh">&#8635; Refresh</button>
    </div>
  </div>
  <div class="cv-stats" id="stats"></div>
</div>
<div class="cv-table-wrap">
  <div id="content" class="cv-empty"><span class="cv-empty-icon">\u2026</span>Loading images\u2026</div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'update') { renderStats(m.stats); render(m.rows); }
  else if (m.type === 'error') showError(m.error);
});

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function renderStats(stats) {
  const el = document.getElementById('stats');
  if (!stats) { el.innerHTML = ''; return; }
  el.innerHTML = stats.map(s =>
    '<div class="cv-stat-card" style="--stat-accent:#FF9900">' +
      '<div class="cv-stat-value">' + escape(s.value) + '</div>' +
      '<div class="cv-stat-label">' + escape(s.label) + '</div>' +
    '</div>'
  ).join('');
}

function showError(msg) {
  const el = document.getElementById('content');
  el.className = 'cv-empty';
  el.innerHTML = '<span class="cv-empty-icon" style="color:#b91c1c">\u26A0</span>' +
    '<div style="color:#b91c1c">' + escape(msg) + '</div>' +
    '<div class="cv-empty-hint">Click Refresh to try again.</div>';
}

function fmtDate(ts) {
  if (!ts) return '<span class="cell-dash">\u2014</span>';
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  const abs = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  let rel;
  if (diff < 60) rel = Math.floor(diff) + 's ago';
  else if (diff < 3600) rel = Math.floor(diff/60) + 'm ago';
  else if (diff < 86400) rel = Math.floor(diff/3600) + 'h ago';
  else if (diff < 2592000) rel = Math.floor(diff/86400) + 'd ago';
  else rel = d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
  return '<span title="' + abs + '">' + rel + '</span>';
}

function render(rows) {
  const el = document.getElementById('content');
  if (!rows || rows.length === 0) {
    el.className = 'cv-empty';
    el.innerHTML = '<span class="cv-empty-icon">\uD83D\uDCE6</span>' +
      '<div>No images in this repository.</div>' +
      '<div class="cv-empty-hint">Push an image with <code>docker push</code> to get started.</div>';
    return;
  }
  el.className = '';

  let html = '<table class="cv-table">' +
    '<thead><tr>' +
      '<th style="width:40%">Tags</th>' +
      '<th>Pushed</th>' +
      '<th>Size</th>' +
      '<th>Digest</th>' +
      '<th style="width:110px;text-align:right">Actions</th>' +
    '</tr></thead><tbody>';

  for (const r of rows) {
    const tagsHtml = r.tags.length === 0
      ? '<span class="ecr-tag ecr-tag-untagged">&lt;untagged&gt;</span>'
      : r.tags.map(t =>
          '<span class="ecr-tag">' + escape(t) +
            '<button class="ecr-tag-x" data-tag="' + escape(t) + '" title="Delete tag \\'' + escape(t) + '\\'">&times;</button>' +
          '</span>'
        ).join('');

    const size = (r.sizeMB !== undefined && r.sizeMB !== null)
      ? '<span class="cell-num">' + r.sizeMB + ' MB</span>'
      : '<span class="cell-dash">\u2014</span>';

    const digestShort = (r.digest || '').replace(/^sha256:/, '').slice(0, 12);
    const digestHtml = digestShort
      ? '<span class="ecr-digest" title="' + escape(r.digest) + '">sha256:' + escape(digestShort) + '\u2026</span>'
      : '<span class="cell-dash">\u2014</span>';

    html += '<tr>' +
      '<td class="ecr-col-tags">' + tagsHtml + '</td>' +
      '<td>' + fmtDate(r.pushedAt) + '</td>' +
      '<td>' + size + '</td>' +
      '<td>' + digestHtml + '</td>' +
      '<td class="ecr-col-actions">' +
        '<button class="ecr-delete-btn" data-digest="' + escape(r.digest) + '" title="Delete this image (all tags)">' +
          '\uD83D\uDDD1 Delete' +
        '</button>' +
      '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;

  el.querySelectorAll('button.ecr-tag-x').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteTag', tag: btn.getAttribute('data-tag') });
    });
  });
  el.querySelectorAll('button.ecr-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteImage', digest: btn.getAttribute('data-digest') });
    });
  });
}
</script>
</body>
</html>`;
  }
}
