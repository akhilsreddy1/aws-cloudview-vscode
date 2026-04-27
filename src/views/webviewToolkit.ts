import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function generateNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}

export function escapeJsonForEmbed(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildCsp(nonce: string, extraSources: string[] = [], imgSources: string[] = []): string {
  const scriptSrc = `'nonce-${nonce}'`;
  const extra = extraSources.length > 0 ? ' ' + extraSources.join(' ') : '';
  const imgExtra = imgSources.length > 0 ? ' ' + imgSources.join(' ') : '';
  return `default-src 'none'; script-src ${scriptSrc}${extra}; style-src 'unsafe-inline'; img-src data:${imgExtra};`;
}

export function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pathSegments: string[],
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathSegments));
}

// ── AWS service SVG icons ────────────────────────────────────────────────────
// Icons are loaded from `media/icons/<serviceKey>.svg` at module init so the
// sidebar tree view and webviews (welcome panel, service dashboards) render
// the exact same asset. Keys MUST match the lowercase filename stem of the
// corresponding SVG under `media/icons/`.
//
// Adding a new service icon:
//   1. Drop a consistently-named `<serviceKey>.svg` into `media/icons/`.
//   2. Add the key to `ICON_SERVICE_KEYS` below.
//   3. (Optional) add a brand colour to `SERVICE_COLORS` further down.
const ICON_SERVICE_KEYS = [
  "lambda", "s3", "ec2", "rds", "vpc", "ecs", "ecr", "msk",
  "dynamodb", "eventbridge", "redshift", "cloudformation", "stepfunctions",
  "apigateway", "documentdb", "glue", "logs", "sqs",
] as const;

// Locate `media/icons/` from this compiled module. At runtime this file lives at
// `<ext>/dist/views/webviewToolkit.js`, so we go up two levels to reach the
// extension root.
const ICONS_DIR = path.join(__dirname, "..", "..", "media", "icons");

/**
 * Reads an SVG file and strips any XML prolog (`<?xml ... ?>`) so the payload
 * can be embedded directly into webview HTML. Returns `null` when the file is
 * missing so callers can fall back to {@link DEFAULT_ICON}.
 */
function loadIconSvg(serviceKey: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(ICONS_DIR, `${serviceKey}.svg`), "utf8");
    return raw.replace(/^\s*<\?xml[^?]*\?>\s*/i, "").trim();
  } catch {
    return null;
  }
}

export const DEFAULT_ICON = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="40" height="40" rx="8" fill="#FF9900"/>
  <rect x="10" y="10" width="20" height="20" rx="3" fill="white" opacity=".85"/>
</svg>`;

export const AWS_ICONS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const key of ICON_SERVICE_KEYS) {
    const svg = loadIconSvg(key);
    if (svg) {
      map[key] = svg;
    }
  }
  return map;
})();

/** Brand colour per service — used for header accent + stats. */
export const SERVICE_COLORS: Record<string, string> = {
  lambda:      '#FF9900',
  s3:          '#7AA116',
  ec2:         '#FF9900',
  rds:         '#527FFF',
  vpc:         '#8C4FFF',
  ecs:         '#FF9900',
  ecr:         '#FF9900',
  msk:         '#C7131F',
  dynamodb:    '#4053D6',
  iam:         '#DD344C',
  eventbridge: '#E7157B',
  redshift:    '#8C4FFF',
  stepfunctions: '#C925D1',
  logs:        '#E7157B',
};

// ── Modern light theme styles ────────────────────────────────────────────────
export const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #f4f6f9;
    --surface:   #ffffff;
    --surface-2: #f8fafc;
    --surface-3: #eef1f5;
    --border:    #e4e8ee;
    --border-2:  #cfd5dd;
    --text:      #0f172a;
    --text-2:    #334155;
    --muted:     #64748b;
    --light:     #94a3b8;
    --accent:    #FF9900;
    --accent-soft: rgba(255,153,0,.12);
    --radius:    10px;
    --radius-sm: 6px;
    --radius-lg: 14px;
    --shadow-xs: 0 1px 2px rgba(15,23,42,.04);
    --shadow-sm: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    --shadow:    0 4px 12px rgba(15,23,42,.08);
    --shadow-lg: 0 20px 40px rgba(15,23,42,.14);
  }

  html, body { height: 100%; overflow: hidden; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* ── Header ── */
  .cv-header {
    background: linear-gradient(to bottom, var(--surface) 0%, var(--surface) 65%, var(--bg) 100%);
    border-bottom: 1px solid var(--border);
    padding: 18px 24px 16px;
    flex-shrink: 0;
  }
  .cv-header-top {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
  }
  .cv-service-icon {
    width: 44px; height: 44px; flex-shrink: 0;
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .cv-service-icon svg { width: 44px; height: 44px; display: block; }
  .cv-title-group { display: flex; flex-direction: column; gap: 2px; }
  .cv-service-title {
    font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -.4px; line-height: 1.1;
  }
  .cv-service-subtitle {
    font-size: 11px; color: var(--muted); font-weight: 500;
    display: flex; align-items: center; gap: 6px;
  }
  .cv-sep { color: var(--light); opacity: .7; }
  .cv-header-actions {
    margin-left: auto; display: flex; gap: 6px; align-items: center;
  }
  /* Legacy / existing-panel meta chip kept for backward compat */
  .cv-header-meta {
    font-size: 11px; color: var(--muted); margin-left: auto;
    padding: 3px 10px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 99px; font-weight: 500; font-variant-numeric: tabular-nums;
  }
  .cv-kbd {
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 10px;
    background: var(--surface-3); border: 1px solid var(--border);
    padding: 2px 6px; border-radius: 4px; color: var(--muted); font-weight: 500;
  }
  .cv-btn {
    background: var(--surface); border: 1px solid var(--border-2); color: var(--text-2);
    padding: 6px 12px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px;
    display: inline-flex; align-items: center; gap: 6px; transition: all .15s;
    font-weight: 500; font-family: inherit;
  }
  .cv-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .cv-btn:active { transform: scale(.97); }
  .cv-btn svg { width: 13px; height: 13px; }

  /* ── Stats ── */
  .cv-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px; flex-shrink: 0;
  }
  .cv-stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px 12px;
    position: relative; overflow: hidden;
    transition: box-shadow .2s, transform .2s, border-color .2s;
    cursor: default; box-shadow: var(--shadow-xs);
  }
  .cv-stat-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: var(--stat-accent, var(--accent));
    opacity: .9;
  }
  .cv-stat-card:hover {
    box-shadow: var(--shadow); transform: translateY(-2px);
    border-color: var(--stat-accent, var(--accent));
  }
  .cv-stat-value {
    font-size: 26px; font-weight: 700; color: var(--stat-accent, var(--accent));
    line-height: 1.1; letter-spacing: -.6px; font-variant-numeric: tabular-nums;
  }
  .cv-stat-label {
    font-size: 11px; color: var(--muted); margin-top: 4px;
    font-weight: 500; text-transform: uppercase; letter-spacing: .04em;
  }
  .cv-stat-sub {
    font-size: 10px; color: var(--light); margin-top: 3px; font-weight: 500;
  }

  /* ── Tabs ── */
  .cv-tabs-wrap {
    background: var(--surface); border-bottom: 1px solid var(--border);
    flex-shrink: 0; padding: 0 24px;
  }
  /* Standalone .cv-tabs (no wrapper) — keep background + border for compat */
  .cv-tabs {
    display: flex; overflow-x: auto; gap: 2px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 0 24px; flex-shrink: 0;
  }
  .cv-tabs-wrap .cv-tabs { background: transparent; border-bottom: none; padding: 0; }
  .cv-tab {
    padding: 11px 14px; cursor: pointer; font-size: 12.5px; font-weight: 500;
    color: var(--muted); border-bottom: 2px solid transparent;
    white-space: nowrap; transition: color .12s, border-color .12s; user-select: none;
    display: flex; align-items: center; gap: 7px;
    position: relative; top: 1px;
  }
  .cv-tab:hover { color: var(--text); }
  .cv-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .cv-tab-count {
    background: var(--surface-3); border-radius: 99px; padding: 1px 7px;
    font-size: 10px; font-weight: 700; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .cv-tab.active .cv-tab-count { background: var(--accent-soft); color: var(--accent); }

  /* ── Toolbar ── */
  .cv-toolbar {
    display: flex; align-items: center; gap: 10px; padding: 10px 24px;
    background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .cv-search-wrap { position: relative; flex: 1; max-width: 360px; }
  .cv-search {
    width: 100%;
    background: var(--surface-2); border: 1px solid var(--border-2); color: var(--text);
    padding: 6px 10px 6px 30px; border-radius: var(--radius-sm); font-size: 12.5px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.25'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: 10px center;
    transition: border-color .15s, box-shadow .15s;
    font-family: inherit;
  }
  .cv-search::placeholder { color: var(--light); }
  .cv-search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .cv-search-kbd {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    pointer-events: none;
  }
  .cv-search:focus + .cv-search-kbd { display: none; }
  .cv-count {
    font-size: 11px; color: var(--muted); white-space: nowrap; font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .cv-toolbar-spacer { flex: 1; }
  .cv-chip-group { display: flex; gap: 4px; align-items: center; }
  .cv-chip {
    padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 500;
    background: var(--surface-2); color: var(--muted); cursor: pointer;
    border: 1px solid var(--border); transition: all .12s; user-select: none;
  }
  .cv-chip:hover { color: var(--text); border-color: var(--border-2); }
  .cv-chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }

  /* ── Table ── */
  .cv-table-wrap { flex: 1; overflow: auto; background: var(--surface); }
  .cv-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .cv-table thead { position: sticky; top: 0; z-index: 10; }
  .cv-table thead th {
    background: var(--surface-2); border-bottom: 1px solid var(--border);
    padding: 9px 18px; text-align: left; font-weight: 600; font-size: 10.5px;
    text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
    cursor: pointer; user-select: none; white-space: nowrap;
    transition: background .1s, color .1s;
  }
  .cv-table thead th:hover { background: var(--surface-3); color: var(--text-2); }
  .cv-table thead th.sorted { color: var(--accent); }
  .sort-arrow { margin-left: 5px; opacity: .3; font-size: 9px; }
  .cv-table thead th.sorted .sort-arrow { opacity: 1; }
  .cv-table tbody tr { cursor: pointer; border-bottom: 1px solid var(--border); transition: background .08s; }
  .cv-table tbody tr:hover { background: var(--surface-2); }
  .cv-table tbody tr.selected {
    background: var(--accent-soft) !important;
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .cv-table tbody td {
    padding: 9px 18px; max-width: 280px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; color: var(--text);
  }
  .cv-table tbody td:first-child { font-weight: 600; color: var(--text); }

  /* ── Badges ── */
  .badge {
    display: inline-flex; align-items: center; padding: 2px 9px;
    border-radius: 99px; font-size: 10.5px; font-weight: 600;
    letter-spacing: .02em; border: 1px solid transparent;
    text-transform: capitalize; line-height: 1.5;
  }
  .badge::before {
    content: ''; width: 6px; height: 6px; border-radius: 99px;
    background: currentColor; margin-right: 6px; flex-shrink: 0;
  }
  .badge-green  { background: #dcfce7; color: #15803d; border-color: #bbf7d0; }
  .badge-red    { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
  .badge-yellow { background: #fef9c3; color: #a16207; border-color: #fef08a; }
  .badge-blue   { background: #dbeafe; color: #1d4ed8; border-color: #bfdbfe; }
  .badge-purple { background: #ede9fe; color: #6d28d9; border-color: #ddd6fe; }
  .badge-orange { background: #ffedd5; color: #c2410c; border-color: #fed7aa; }
  .badge-grey   { background: #f1f5f9; color: #64748b; border-color: #e2e8f0; }

  /* ── Typed cells ── */
  .cell-code {
    font-family: ui-monospace, 'SF Mono', 'Fira Code', monospace; font-size: 11px;
    background: var(--surface-2); border: 1px solid var(--border);
    padding: 2px 6px; border-radius: 4px; color: var(--text-2);
    max-width: 240px; overflow: hidden; text-overflow: ellipsis; display: inline-block;
    vertical-align: middle;
  }
  .cell-bool-yes {
    color: #15803d; font-weight: 600;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .cell-bool-no { color: var(--light); display: inline-flex; align-items: center; gap: 4px; }
  .cell-dash    { color: var(--light); font-weight: 400; }
  .cell-num     { font-variant-numeric: tabular-nums; font-weight: 500; }

  /* ── Empty ── */
  .cv-empty {
    text-align: center; padding: 80px 20px !important;
    color: var(--light) !important;
    font-size: 14px; font-weight: 500 !important;
  }
  /* .cv-empty-icon works as inline span OR block div */
  .cv-empty-icon {
    display: inline-block; font-size: 28px; line-height: 1;
    margin: 0 auto 10px; color: var(--light); opacity: .7;
  }
  td.cv-empty .cv-empty-icon { display: block; }
  .cv-empty-hint {
    font-size: 12px; color: var(--light); margin-top: 4px; font-weight: normal;
  }
  /* .cv-export — subtle export button in toolbar */
  .cv-export { margin-left: auto; font-size: 11px; font-weight: 600; }

  /* ── Overlay + Drawer ── */
  #cv-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(15,23,42,.25); z-index: 90;
    backdrop-filter: blur(2px);
  }
  .cv-drawer {
    position: fixed; top: 0; right: 0; width: 460px; max-width: 90vw; height: 100vh;
    background: var(--surface); border-left: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    overflow-y: auto; transform: translateX(100%);
    transition: transform .25s cubic-bezier(.4,0,.2,1); z-index: 100;
    display: flex; flex-direction: column;
  }
  .cv-drawer.open { transform: translateX(0); }
  .cv-drawer-header {
    position: sticky; top: 0; z-index: 2;
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 16px 20px; display: flex; align-items: flex-start;
    justify-content: space-between; gap: 12px;
  }
  .cv-drawer-name {
    font-weight: 700; font-size: 15px; color: var(--text);
    word-break: break-all; line-height: 1.3;
  }
  .cv-drawer-arn {
    font-size: 10.5px; color: var(--muted); margin-top: 4px;
    font-family: ui-monospace, 'SF Mono', monospace; word-break: break-all;
  }
  .cv-drawer-close {
    flex-shrink: 0; background: var(--surface-2); border: 1px solid var(--border);
    color: var(--muted); width: 28px; height: 28px; border-radius: var(--radius-sm);
    cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;
    transition: all .15s;
  }
  .cv-drawer-close:hover { background: #fee2e2; border-color: #fecaca; color: #b91c1c; }
  .cv-drawer-body { padding: 0 20px 32px; flex: 1; }

  .cv-drawer-tabs {
    display: flex; gap: 2px; padding: 0 20px;
    background: var(--surface); border-bottom: 1px solid var(--border);
  }
  .cv-dtab {
    padding: 10px 12px; font-size: 11.5px; font-weight: 600; cursor: pointer;
    color: var(--muted); border-bottom: 2px solid transparent;
    text-transform: uppercase; letter-spacing: .04em;
    position: relative; top: 1px;
  }
  .cv-dtab:hover { color: var(--text-2); }
  .cv-dtab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .cv-detail-section { margin-top: 20px; }
  .cv-detail-section-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
    color: var(--muted); padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .cv-detail-row {
    display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--surface-3);
    align-items: flex-start;
  }
  .cv-detail-row:last-child { border-bottom: none; }
  .cv-detail-key {
    min-width: 130px; max-width: 130px; font-size: 11px; font-weight: 500;
    color: var(--muted); padding-top: 2px; text-transform: capitalize;
  }
  .cv-detail-val {
    font-size: 12px; color: var(--text); word-break: break-all; flex: 1;
    font-family: ui-monospace, 'SF Mono', monospace;
  }
  .cv-copy-btn {
    font-size: 10px; color: var(--muted); background: transparent;
    border: 1px solid var(--border); padding: 1px 6px; border-radius: 3px;
    margin-left: 6px; cursor: pointer; font-family: inherit;
    transition: all .12s;
  }
  .cv-copy-btn:hover { color: var(--accent); border-color: var(--accent); }
  .cv-json {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 12px; font-size: 11px;
    font-family: ui-monospace, 'SF Mono', monospace; color: var(--text-2);
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    margin-top: 8px; line-height: 1.5;
  }

  /* ── Scrollbars ── */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 4px; border: 2px solid var(--surface); }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  /* ── Loading animation ── */
  @keyframes cv-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .cv-stat-card, .cv-table tbody tr { animation: cv-fade-in .25s ease-out both; }
  .cv-stat-card:nth-child(2) { animation-delay: .03s; }
  .cv-stat-card:nth-child(3) { animation-delay: .06s; }
  .cv-stat-card:nth-child(4) { animation-delay: .09s; }
  .cv-stat-card:nth-child(5) { animation-delay: .12s; }
  .cv-stat-card:nth-child(6) { animation-delay: .15s; }
`;

// ── Shared JS utilities ───────────────────────────────────────────────────────
export const BASE_SCRIPTS = `
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  var STATUS_MAP = {
    available:'green', active:'green', running:'green', enabled:'green', in_use:'green',
    complete:'green', completed:'green', healthy:'green', inservice:'green', succeeded:'green',
    create_complete:'green', update_complete:'green', import_complete:'green',
    failed:'red', error:'red', stopped:'red', deleted:'red', deleting:'red',
    disabled:'red', terminated:'red', incompatible_network:'red', unhealthy:'red',
    delete_in_progress:'red', delete_failed:'red', delete_complete:'red',
    rollback_in_progress:'red', rollback_complete:'red', rollback_failed:'red',
    update_rollback_in_progress:'red', update_rollback_complete:'red', update_rollback_failed:'red',
    update_rollback_complete_cleanup_in_progress:'red',
    import_rollback_in_progress:'red', import_rollback_complete:'red', import_rollback_failed:'red',
    create_failed:'red', update_failed:'red',
    pending:'yellow', creating:'yellow', modifying:'yellow', rebooting:'yellow',
    resizing:'yellow', upgrading:'yellow', backing_up:'yellow', maintenance:'yellow',
    starting:'yellow', stopping:'yellow', provisioning:'yellow',
    create_in_progress:'yellow', update_in_progress:'yellow', import_in_progress:'yellow',
    update_complete_cleanup_in_progress:'yellow', review_in_progress:'yellow',
    automated:'blue', provisioned:'blue',
    serverless:'purple', pay_per_request:'purple',
    mutable:'orange', manual:'orange', immutable:'blue',
    standard:'blue', express:'orange',
    timed_out:'red', aborted:'red',
  };

  function statusBadge(val) {
    if (val === undefined || val === null) { return '<span class="cell-dash">\\u2014</span>'; }
    var v = String(val).toLowerCase().replace(/[ -]/g,'_');
    var cls = 'badge-' + (STATUS_MAP[v] || 'grey');
    return '<span class="badge ' + cls + '">' + escHtml(String(val).toLowerCase()) + '</span>';
  }

  function formatBytes(b) {
    if (!b || b === 0) { return '0 B'; }
    var k = 1024, sizes = ['B','KB','MB','GB','TB','PB'];
    var i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDate(d) {
    if (!d) { return '<span class="cell-dash">\\u2014</span>'; }
    var dt = new Date(d);
    if (isNaN(dt.getTime())) { return escHtml(String(d)); }
    var now = new Date();
    var diff = (now - dt) / 1000;
    if (diff < 60)    { return Math.floor(diff) + 's ago'; }
    if (diff < 3600)  { return Math.floor(diff/60) + 'm ago'; }
    if (diff < 86400) { return Math.floor(diff/3600) + 'h ago'; }
    if (diff < 2592000) { return Math.floor(diff/86400) + 'd ago'; }
    return dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
  }

  function getMetaVal(resource, key) {
    var meta = resource.metadata || {};
    if (key === 'name')   { return resource.name || resource.id || ''; }
    if (key === 'id')     { return resource.id; }
    if (key === 'arn')    { return resource.arn || meta.arn; }
    if (key === 'state')  { return resource.state; }
    if (key === 'region') { return resource.region || meta.region; }
    if (key === 'accountId') { return resource.accountId || meta.accountId; }
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      return meta[key];
    }
    if (key.indexOf('.') !== -1) {
      var parts = key.split('.');
      var cur = meta;
      for (var i = 0; i < parts.length; i++) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }
    return undefined;
  }

  function renderCell(resource, col) {
    var raw = getMetaVal(resource, col.key);
    if (raw === undefined || raw === null || raw === '') {
      return '<span class="cell-dash">\\u2014</span>';
    }
    var t = col.type;
    if (t === 'status') { return statusBadge(raw); }
    if (t === 'bytes')  { return '<span class="cell-num">' + escHtml(formatBytes(Number(raw))) + '</span>'; }
    if (t === 'date')   { return '<span title="' + escHtml(String(raw)) + '">' + formatDate(raw) + '</span>'; }
    if (t === 'bool')   {
      return raw
        ? '<span class="cell-bool-yes">\\u2713 Yes</span>'
        : '<span class="cell-bool-no">\\u2014</span>';
    }
    if (t === 'code') {
      return '<span class="cell-code" title="' + escHtml(String(raw)) + '">' + escHtml(String(raw)) + '</span>';
    }
    if (t === 'number') { return '<span class="cell-num">' + escHtml(Number(raw).toLocaleString()) + '</span>'; }
    var str = String(raw);
    return str.length > 72
      ? '<span title="' + escHtml(str) + '">' + escHtml(str.slice(0, 70)) + '\\u2026</span>'
      : escHtml(str);
  }

  function rawSortVal(resource, col) {
    var v = getMetaVal(resource, col.key);
    if (v === undefined || v === null) { return ''; }
    if (col.type === 'number' || col.type === 'bytes') { return String(Number(v) || 0).padStart(20, '0'); }
    if (col.type === 'date')   { var d = new Date(v); return isNaN(d.getTime()) ? '' : String(d.getTime()); }
    if (col.type === 'bool')   { return v ? '1' : '0'; }
    return String(v).toLowerCase();
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(function() {
      var t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); document.body.removeChild(t);
    });
  }
`;
