import * as vscode from "vscode";
import { DescribeTaskDefinitionCommand, type ContainerDefinition, type TaskDefinition } from "@aws-sdk/client-ecs";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

/**
 * Renders the ECS task definition behind a task or service: container list
 * (image, CPU/mem, port mappings, env), IAM roles, network mode, and the
 * raw JSON for copy/paste. Environment variable **values** are redacted by
 * default so an over-the-shoulder look at the panel can't leak secrets — the
 * user can click "Show values" to reveal them.
 */
export class EcsTaskDefPanel {
  private static panels = new Map<string, EcsTaskDefPanel>();
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewEcsTaskDef",
      `Task Def: ${resource.name || resource.id}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => EcsTaskDefPanel.panels.delete(resource.arn));

    this.panel.webview.html = this.buildHtml("Loading task definition…");
    void this.load();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = EcsTaskDefPanel.panels.get(resource.arn);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new EcsTaskDefPanel(platform, resource);
    EcsTaskDefPanel.panels.set(resource.arn, instance);
  }

  private resolveTaskDefArn(): string | undefined {
    if (this.resource.type === ResourceTypes.ecsTask) {
      return (this.resource.rawJson.taskDefinitionArn as string) ?? undefined;
    }
    if (this.resource.type === ResourceTypes.ecsService) {
      return (this.resource.rawJson.taskDefinition as string) ?? undefined;
    }
    return undefined;
  }

  private async load(): Promise<void> {
    const taskDefArn = this.resolveTaskDefArn();
    if (!taskDefArn) {
      this.panel.webview.html = this.buildHtml("Could not locate a task definition ARN on this resource.");
      return;
    }

    try {
      const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
      if (!profileName) { throw new Error("No AWS profile resolved for this account."); }

      const scope = { profileName, accountId: this.resource.accountId, region: this.resource.region };
      const client = await this.platform.awsClientFactory.ecs(scope);
      const response = await this.platform.scheduler.run("ecs", "DescribeTaskDefinition", () =>
        client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }))
      );

      const def = response.taskDefinition;
      if (!def) { throw new Error("Task definition not returned by AWS."); }
      this.panel.webview.html = this.render(def);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = this.buildHtml(`Failed to load task definition: ${message}`);
    }
  }

  private render(def: TaskDefinition): string {
    const n = generateNonce();
    const family = escapeHtml(`${def.family ?? "?"}:${def.revision ?? "?"}`);
    const headerRows = [
      ["Family", family],
      ["Network Mode", escapeHtml(def.networkMode ?? "bridge")],
      ["CPU (task)", escapeHtml(def.cpu ?? "—")],
      ["Memory (task)", escapeHtml(def.memory ?? "—")],
      ["Task Role", escapeHtml(shortArn(def.taskRoleArn))],
      ["Execution Role", escapeHtml(shortArn(def.executionRoleArn))],
      ["Requires Compatibilities", escapeHtml((def.requiresCompatibilities ?? []).join(", ") || "—")],
    ];
    const summary = `<table class="kv">${headerRows
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("")}</table>`;

    const containers = (def.containerDefinitions ?? []).map((c) => this.renderContainer(c)).join("");
    const rawJson = escapeHtml(JSON.stringify(def, null, 2));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<title>Task Def</title>
<style>
${BASE_STYLES}
body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.td-header {
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 16px 20px; flex-shrink: 0;
}
.td-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
.td-title .td-icon { color: var(--accent); font-size: 20px; }
.td-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
.td-meta span { display: flex; align-items: center; gap: 4px; }
.td-meta .label { font-weight: 600; }

.td-body { flex: 1; overflow: auto; padding: 16px 20px; }
.td-section { margin-bottom: 20px; }
.td-section-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin-bottom: 8px;
}
table.kv { border-collapse: collapse; font-size: 12px; width: 100%; }
table.kv th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 16px 4px 0; vertical-align: top; white-space: nowrap; }
table.kv td { padding: 4px 0; vertical-align: top; color: var(--text); }
.container {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  margin-bottom: 10px; padding: 12px 14px; background: var(--surface);
  box-shadow: var(--shadow-xs);
}
.container h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; color: var(--text); }
.chip {
  display: inline-block; padding: 2px 8px; font-size: 10px; font-weight: 600;
  border-radius: 99px; background: var(--surface-3); color: var(--muted);
  border: 1px solid var(--border);
}
.image { font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; color: var(--accent); word-break: break-all; }
.env { margin-top: 8px; }
.env strong { font-size: 11px; font-weight: 600; color: var(--text-2); display: block; margin-bottom: 4px; }
.env-row { display: flex; font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; padding: 2px 0; gap: 12px; }
.env-key { color: var(--muted); min-width: 180px; flex-shrink: 0; }
.env-val { color: var(--text); }
.env-val.redacted { color: var(--light); font-style: italic; }
.td-toolbar {
  display: flex; gap: 8px; padding: 8px 20px; align-items: center;
  border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0;
}
.td-toolbar label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; cursor: pointer; }
.td-toolbar input[type=checkbox] { accent-color: var(--accent); }
pre.raw-json {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 12px 14px; font-size: 11px; font-family: ui-monospace, 'SF Mono', monospace;
  line-height: 1.5; overflow: auto; max-height: 420px; color: var(--text);
}
</style>
</head>
<body>
<div class="td-header">
  <div class="td-title"><span class="td-icon">\u{1F4E6}</span> ${family}</div>
  <div class="td-meta">
    <span><span class="label">Network:</span> ${escapeHtml(def.networkMode ?? "bridge")}</span>
    <span><span class="label">CPU:</span> ${escapeHtml(def.cpu ?? "—")}</span>
    <span><span class="label">Memory:</span> ${escapeHtml(def.memory ?? "—")}</span>
    <span><span class="label">Compatibilities:</span> ${escapeHtml((def.requiresCompatibilities ?? []).join(", ") || "—")}</span>
  </div>
</div>
<div class="td-toolbar">
  <label><input type="checkbox" id="showValues"> Show env values</label>
</div>
<div class="td-body">
  <div class="td-section">
    <div class="td-section-title">Summary</div>
    ${summary}
  </div>
  <div class="td-section">
    <div class="td-section-title">Containers (${(def.containerDefinitions ?? []).length})</div>
    ${containers || '<em style="color:var(--muted)">No containers.</em>'}
  </div>
  <div class="td-section">
    <div class="td-section-title">Raw JSON</div>
    <pre class="raw-json">${rawJson}</pre>
  </div>
</div>
<script nonce="${n}">
const toggle = document.getElementById('showValues');
toggle.addEventListener('change', () => {
  document.querySelectorAll('.env-val').forEach(el => {
    if (toggle.checked) { el.textContent = el.dataset.value ?? ''; el.classList.remove('redacted'); }
    else { el.textContent = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022'; el.classList.add('redacted'); }
  });
});
</script>
</body>
</html>`;
  }

  private renderContainer(c: ContainerDefinition): string {
    const name = escapeHtml(c.name ?? "(unnamed)");
    const image = escapeHtml(c.image ?? "—");
    const cpu = c.cpu ?? "—";
    const mem = c.memory ?? c.memoryReservation ?? "—";
    const ports = (c.portMappings ?? [])
      .map((p) => `${p.containerPort}${p.hostPort && p.hostPort !== p.containerPort ? `→${p.hostPort}` : ""}/${p.protocol ?? "tcp"}`)
      .join(", ");
    const envRows = (c.environment ?? []).map((e) => {
      const k = escapeHtml(e.name ?? "");
      const v = escapeHtml(e.value ?? "");
      return `<div class="env-row"><span class="env-key">${k}</span><span class="env-val redacted" data-value="${v}">\u2022\u2022\u2022\u2022\u2022\u2022</span></div>`;
    }).join("");
    const secrets = (c.secrets ?? []).map((s) =>
      `<div class="env-row"><span class="env-key">${escapeHtml(s.name ?? "")}</span><span class="env-val">${escapeHtml(shortArn(s.valueFrom))} <span class="chip">secret</span></span></div>`
    ).join("");

    return `<div class="container">
      <h3>${name} <span class="chip">cpu ${cpu}</span> <span class="chip">mem ${mem}</span>${c.essential ? ' <span class="chip">essential</span>' : ""}</h3>
      <div class="image">${image}</div>
      ${ports ? `<div style="margin-top:8px;font-size:12px;"><strong style="font-size:11px;font-weight:600;color:var(--text-2);">Ports:</strong> ${escapeHtml(ports)}</div>` : ""}
      ${envRows ? `<div class="env"><strong>Environment</strong>${envRows}</div>` : ""}
      ${secrets ? `<div class="env"><strong>Secrets</strong>${secrets}</div>` : ""}
    </div>`;
  }

  private buildHtml(message: string): string {
    const n = generateNonce();
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<style>${BASE_STYLES} .msg { padding:20px; color:var(--vscode-descriptionForeground); }</style>
</head><body><div class="msg">${escapeHtml(message)}</div></body></html>`;
  }
}

function shortArn(arn?: string | null): string {
  if (!arn) { return "—"; }
  const parts = arn.split("/");
  return parts[parts.length - 1] || arn;
}
