import * as vscode from "vscode";
import {
  ReceiveMessageCommand,
  StartMessageMoveTaskCommand,
  ListMessageMoveTasksCommand,
  CancelMessageMoveTaskCommand,
  type Message,
  type MessageSystemAttributeName,
} from "@aws-sdk/client-sqs";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

interface PeekedMessage {
  messageId: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, string>;
  receivedAt: number;
  approxReceiveCount?: string;
  sentTimestamp?: string;
}

/**
 * Webview for an SQS queue: peek messages (non-destructive — uses
 * VisibilityTimeout=0 so nothing is hidden from other consumers) and, when the
 * queue appears to be a dead-letter queue, trigger an AWS-managed redrive to
 * move messages back to the source queue(s) via `StartMessageMoveTask`.
 *
 * The panel never deletes messages. Tailing is read-only; redrive is handed
 * off to the SQS service, which manages throughput and retries server-side.
 */
export class SqsMessagesPanel {
  private static panels = new Map<string, SqsMessagesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly queueName: string;
  private readonly queueUrl: string;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.queueName = (resource.rawJson.QueueName as string) ?? resource.name ?? resource.id;
    this.queueUrl = (resource.rawJson.QueueUrl as string)
      ?? `https://sqs.${resource.region}.amazonaws.com/${resource.accountId}/${this.queueName}`;

    this.panel = vscode.window.createWebviewPanel(
      "cloudViewSqsMessages",
      `SQS: ${this.queueName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => SqsMessagesPanel.panels.delete(resource.arn));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "peek") {
          await this.peekMessages(Number(msg.count) || 10);
        } else if (msg.type === "startRedrive") {
          await this.startRedrive(
            typeof msg.maxPerSecond === "number" ? msg.maxPerSecond : undefined,
          );
        } else if (msg.type === "listTasks") {
          await this.listRedriveTasks();
        } else if (msg.type === "cancelTask" && typeof msg.taskHandle === "string") {
          await this.cancelRedriveTask(msg.taskHandle);
        }
      } catch (err: unknown) {
        this.postError(err instanceof Error ? err.message : String(err));
      }
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = SqsMessagesPanel.panels.get(resource.arn);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const instance = new SqsMessagesPanel(platform, resource);
    SqsMessagesPanel.panels.set(resource.arn, instance);
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
   * Receive up to `count` messages with `VisibilityTimeout=0` so the peek is
   * non-destructive — nothing becomes invisible to other consumers, and no
   * delete calls are made. Message receipt handles are deliberately discarded.
   */
  private async peekMessages(count: number): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    const client = await this.platform.awsClientFactory.sqs(scope);
    const capped = Math.max(1, Math.min(count, 10));

    try {
      const resp = await this.platform.scheduler.run("sqs", "ReceiveMessage", () =>
        client.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: capped,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 0,
          MessageAttributeNames: ["All"],
          MessageSystemAttributeNames: ["All" as MessageSystemAttributeName],
        }))
      );

      const messages: PeekedMessage[] = (resp.Messages ?? []).map((m: Message) => {
        const attrs = m.Attributes ?? {};
        const msgAttrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.MessageAttributes ?? {})) {
          msgAttrs[k] = v.StringValue ?? v.BinaryValue?.toString() ?? "";
        }
        return {
          messageId: m.MessageId ?? "(no id)",
          body: m.Body ?? "",
          attributes: attrs as Record<string, string>,
          messageAttributes: msgAttrs,
          receivedAt: Date.now(),
          approxReceiveCount: attrs.ApproximateReceiveCount,
          sentTimestamp: attrs.SentTimestamp,
        };
      });

      void this.panel.webview.postMessage({ type: "peekResult", messages });
    } catch (err: unknown) {
      this.postError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Start an AWS-managed redrive task. With `SourceArn` only, SQS moves
   * messages back to whichever source queue originally redrived them. SQS
   * throttles and retries internally; we just kick it off and poll status.
   */
  private async startRedrive(maxPerSecond?: number): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    const confirmed = await vscode.window.showWarningMessage(
      `Redrive messages from "${this.queueName}" back to their source queue(s)?`,
      {
        modal: true,
        detail:
          "AWS SQS will move messages from this DLQ back to the source queue(s) that originally redrove them. This is throttled server-side and runs in the background. Requires that this queue is configured as a DLQ (i.e. another queue's RedrivePolicy targets it).",
      },
      "Start redrive",
    );
    if (confirmed !== "Start redrive") return;

    const client = await this.platform.awsClientFactory.sqs(scope);
    try {
      const resp = await this.platform.scheduler.run("sqs", "StartMessageMoveTask", () =>
        client.send(new StartMessageMoveTaskCommand({
          SourceArn: this.resource.arn,
          MaxNumberOfMessagesPerSecond: maxPerSecond,
        }))
      );
      void vscode.window.showInformationMessage(
        `Redrive started for "${this.queueName}". Task: ${resp.TaskHandle?.slice(0, 32) ?? "(unknown)"}\u2026`,
      );
      void this.panel.webview.postMessage({ type: "redriveStarted", taskHandle: resp.TaskHandle });
      await this.listRedriveTasks();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`Redrive failed: ${message}`);
    }
  }

  private async listRedriveTasks(): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    const client = await this.platform.awsClientFactory.sqs(scope);
    try {
      const resp = await this.platform.scheduler.run("sqs", "ListMessageMoveTasks", () =>
        client.send(new ListMessageMoveTasksCommand({
          SourceArn: this.resource.arn,
          MaxResults: 10,
        }))
      );
      const tasks = (resp.Results ?? []).map((t) => ({
        taskHandle: t.TaskHandle,
        status: t.Status,
        sourceArn: t.SourceArn,
        destinationArn: t.DestinationArn,
        approximateNumberOfMessagesMoved: t.ApproximateNumberOfMessagesMoved,
        approximateNumberOfMessagesToMove: t.ApproximateNumberOfMessagesToMove,
        maxNumberOfMessagesPerSecond: t.MaxNumberOfMessagesPerSecond,
        startedTimestamp: t.StartedTimestamp,
        failureReason: t.FailureReason,
      }));
      void this.panel.webview.postMessage({ type: "tasksResult", tasks });
    } catch (err: unknown) {
      // Listing tasks is informational; failures shouldn't block the panel.
      this.postError(err instanceof Error ? err.message : String(err));
    }
  }

  private async cancelRedriveTask(taskHandle: string): Promise<void> {
    const scope = await this.resolveScope();
    if (!scope) return;

    const client = await this.platform.awsClientFactory.sqs(scope);
    try {
      await this.platform.scheduler.run("sqs", "CancelMessageMoveTask", () =>
        client.send(new CancelMessageMoveTaskCommand({ TaskHandle: taskHandle }))
      );
      void vscode.window.showInformationMessage("Redrive task cancelled.");
      await this.listRedriveTasks();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postError(`Cancel failed: ${message}`);
    }
  }

  private postError(message: string): void {
    void this.panel.webview.postMessage({ type: "error", message });
  }

  private buildHtml(): string {
    const n = generateNonce();
    const name = escapeHtml(this.queueName);
    const arn = escapeHtml(this.resource.arn);
    const region = escapeHtml(this.resource.region);
    const raw = this.resource.rawJson as Record<string, unknown>;
    const fifo = Boolean(raw.IsFifo);
    const visible = Number(raw.VisibleMessages ?? 0);
    const inFlight = Number(raw.InFlightMessages ?? 0);
    const delayed = Number(raw.DelayedMessages ?? 0);
    const dlqTarget = raw.DlqTargetArn as string | undefined;
    const isDlqSource = Boolean(raw.IsDlqSource);
    const looksLikeDlq = Boolean(raw.LooksLikeDlq);
    // Only show redrive UI when this queue is plausibly a DLQ. The authoritative
    // signal (another queue points its RedrivePolicy at this one) requires a
    // cross-resource resolver pass; until that's wired, fall back to the name
    // heuristic so the button doesn't disappear on fresh data.
    const canRedrive = looksLikeDlq && !isDlqSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
  <title>SQS: ${name}</title>
  <style>
    ${BASE_STYLES}
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .sqs-header {
      background: var(--surface); border-bottom: 1px solid var(--border);
      padding: 16px 20px; flex-shrink: 0;
    }
    .sqs-title { font-size: 18px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .sqs-title .q-icon { color: #E7157B; font-size: 20px; }
    .sqs-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
    .sqs-meta span { display: flex; align-items: center; gap: 4px; }
    .sqs-meta .label { font-weight: 600; }
    .arn-row { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); margin-top: 6px; word-break: break-all; }

    .toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .toolbar label { font-size: 11px; color: var(--muted); font-weight: 600; }
    .toolbar input, .toolbar select {
      background: var(--surface); border: 1px solid var(--border-2); color: var(--text);
      padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px;
    }
    .btn {
      background: var(--accent); color: white; border: none;
      padding: 6px 14px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .btn:hover { background: #e68a00; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.danger { background: #C7131F; }
    .btn.danger:hover { background: #a2101a; }
    .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border-2); }
    .btn.ghost:hover { background: var(--surface-3); }

    .tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 20px; flex-shrink: 0; background: var(--surface); }
    .tab { padding: 10px 14px; cursor: pointer; font-size: 12px; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .content { flex: 1; overflow: auto; padding: 16px 20px; }
    .pane { display: none; }
    .pane.active { display: block; }

    .empty-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--light); padding: 40px; text-align: center;
    }
    .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

    .msg-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      margin-bottom: 10px; overflow: hidden;
    }
    .msg-head {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      background: var(--surface-2); border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--muted); flex-wrap: wrap;
    }
    .msg-id { font-family: 'SF Mono', 'Fira Code', monospace; font-weight: 600; color: var(--text); }
    .msg-body {
      padding: 10px 12px; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      max-height: 280px; overflow: auto;
    }
    .msg-attrs { padding: 6px 12px 10px; font-size: 11px; color: var(--muted); border-top: 1px dashed var(--border); }
    .msg-attrs strong { color: var(--text-2); font-weight: 600; }

    .task-row {
      display: grid; grid-template-columns: auto 1fr auto auto auto;
      gap: 10px; align-items: center; padding: 8px 12px;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 6px;
      font-size: 12px;
    }
    .task-status { font-weight: 600; }
    .task-status.running { color: #d97706; }
    .task-status.completed { color: #16a34a; }
    .task-status.failed, .task-status.cancelled { color: #dc2626; }

    .error-banner {
      background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
      padding: 8px 12px; border-radius: var(--radius); margin: 10px 20px;
      font-size: 12px; display: none;
    }
  </style>
</head>
<body>
  <div class="sqs-header">
    <div class="sqs-title">
      <span class="q-icon">\u{1F4EC}</span>
      <span>${name}</span>
      ${fifo ? '<span class="badge badge-blue" style="margin-left:6px;">FIFO</span>' : ""}
      ${canRedrive ? '<span class="badge badge-red" style="margin-left:6px;">DLQ</span>' : ""}
    </div>
    <div class="sqs-meta">
      <span><span class="label">Region:</span> ${region}</span>
      <span><span class="label">Visible:</span> ${visible}</span>
      <span><span class="label">In-flight:</span> ${inFlight}</span>
      <span><span class="label">Delayed:</span> ${delayed}</span>
      ${dlqTarget ? `<span><span class="label">Redrives to:</span> ${escapeHtml(dlqTarget)}</span>` : ""}
    </div>
    <div class="arn-row">${arn}</div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="toolbar">
    <label>Peek</label>
    <select id="peek-count">
      <option value="1">1 msg</option>
      <option value="5">5 msgs</option>
      <option value="10" selected>10 msgs</option>
    </select>
    <button class="btn" id="peek-btn">Receive (non-destructive)</button>
    ${canRedrive ? `
    <span style="flex:1;"></span>
    <label>Max msg/sec</label>
    <input id="redrive-rate" type="number" min="1" max="500" placeholder="unlimited" style="width:100px;" />
    <button class="btn danger" id="redrive-btn">\u21BB Redrive to source</button>
    <button class="btn ghost" id="tasks-btn">Refresh tasks</button>
    ` : ""}
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="messages">Messages</div>
    ${canRedrive ? '<div class="tab" data-tab="tasks">Redrive tasks</div>' : ""}
  </div>

  <div class="content">
    <div class="pane active" id="pane-messages">
      <div class="empty-state" id="msg-empty">
        <div class="icon">\u{1F4EC}</div>
        <div>Click <strong>Receive</strong> to peek up to 10 messages without consuming them.</div>
        <div style="font-size: 11px; margin-top: 6px;">SQS returns messages best-effort: short polling may return fewer than requested even if the queue is non-empty.</div>
      </div>
      <div id="msg-list"></div>
    </div>
    ${canRedrive ? `
    <div class="pane" id="pane-tasks">
      <div class="empty-state" id="tasks-empty">
        <div class="icon">\u21BB</div>
        <div>No active or recent redrive tasks.</div>
      </div>
      <div id="tasks-list"></div>
    </div>
    ` : ""}
  </div>

  <script nonce="${n}">
    var vscode = acquireVsCodeApi();
    var peekBtn = document.getElementById('peek-btn');
    var peekCount = document.getElementById('peek-count');
    var redriveBtn = document.getElementById('redrive-btn');
    var tasksBtn = document.getElementById('tasks-btn');
    var rateInput = document.getElementById('redrive-rate');
    var errorBanner = document.getElementById('error-banner');

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showError(msg) {
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      setTimeout(function(){ errorBanner.style.display = 'none'; }, 8000);
    }

    peekBtn.onclick = function() {
      peekBtn.disabled = true;
      peekBtn.textContent = 'Receiving\u2026';
      vscode.postMessage({ type: 'peek', count: Number(peekCount.value) });
    };

    if (redriveBtn) {
      redriveBtn.onclick = function() {
        var rate = rateInput.value ? Number(rateInput.value) : undefined;
        vscode.postMessage({ type: 'startRedrive', maxPerSecond: rate });
      };
    }
    if (tasksBtn) {
      tasksBtn.onclick = function() {
        vscode.postMessage({ type: 'listTasks' });
      };
    }

    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.onclick = function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.pane').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'tasks') {
          vscode.postMessage({ type: 'listTasks' });
        }
      };
    });

    function fmtTs(ms) {
      var n = Number(ms);
      if (!isFinite(n) || n <= 0) return '';
      try { return new Date(n).toLocaleString(); } catch (_) { return String(ms); }
    }

    function renderMessages(list) {
      var container = document.getElementById('msg-list');
      var empty = document.getElementById('msg-empty');
      if (!list || list.length === 0) {
        empty.style.display = 'flex';
        container.innerHTML = '';
        empty.querySelector('div:nth-child(2)').innerHTML = 'Queue returned no messages. Try again \u2014 short polling is best-effort.';
        return;
      }
      empty.style.display = 'none';
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var sentAt = m.sentTimestamp ? fmtTs(Number(m.sentTimestamp)) : '';
        var attrLines = '';
        var sysKeys = Object.keys(m.attributes || {});
        for (var j = 0; j < sysKeys.length; j++) {
          var k = sysKeys[j];
          attrLines += '<div><strong>' + esc(k) + ':</strong> ' + esc(m.attributes[k]) + '</div>';
        }
        var msgAttrKeys = Object.keys(m.messageAttributes || {});
        for (var k2 = 0; k2 < msgAttrKeys.length; k2++) {
          var mk = msgAttrKeys[k2];
          attrLines += '<div><strong>attr.' + esc(mk) + ':</strong> ' + esc(m.messageAttributes[mk]) + '</div>';
        }
        html += '<div class="msg-card">' +
          '<div class="msg-head">' +
            '<span class="msg-id">' + esc(m.messageId) + '</span>' +
            (m.approxReceiveCount ? '<span>receive #' + esc(m.approxReceiveCount) + '</span>' : '') +
            (sentAt ? '<span>sent ' + esc(sentAt) + '</span>' : '') +
          '</div>' +
          '<div class="msg-body">' + esc(m.body || '(empty)') + '</div>' +
          (attrLines ? '<div class="msg-attrs">' + attrLines + '</div>' : '') +
          '</div>';
      }
      container.innerHTML = html;
    }

    function renderTasks(tasks) {
      var container = document.getElementById('tasks-list');
      var empty = document.getElementById('tasks-empty');
      if (!container) return;
      if (!tasks || tasks.length === 0) {
        empty.style.display = 'flex';
        container.innerHTML = '';
        return;
      }
      empty.style.display = 'none';
      var html = '';
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        var statusClass = String(t.status || '').toLowerCase();
        var moved = t.approximateNumberOfMessagesMoved != null ? t.approximateNumberOfMessagesMoved : '?';
        var total = t.approximateNumberOfMessagesToMove != null ? t.approximateNumberOfMessagesToMove : '?';
        var dest = t.destinationArn || '(source queue)';
        var cancelBtn = (statusClass === 'running' && t.taskHandle)
          ? '<button class="btn ghost" data-handle="' + esc(t.taskHandle) + '">Cancel</button>'
          : '';
        html += '<div class="task-row">' +
          '<span class="task-status ' + statusClass + '">' + esc(t.status || '?') + '</span>' +
          '<span>' + esc(dest) + '</span>' +
          '<span>' + esc(String(moved)) + ' / ' + esc(String(total)) + '</span>' +
          '<span>' + esc(fmtTs(t.startedTimestamp)) + '</span>' +
          cancelBtn +
          '</div>';
        if (t.failureReason) {
          html += '<div style="font-size:11px; color:#dc2626; margin:-2px 0 8px 12px;">' + esc(t.failureReason) + '</div>';
        }
      }
      container.innerHTML = html;
      container.querySelectorAll('button[data-handle]').forEach(function(btn) {
        btn.onclick = function() { vscode.postMessage({ type: 'cancelTask', taskHandle: btn.getAttribute('data-handle') }); };
      });
    }

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'peekResult') {
        peekBtn.disabled = false;
        peekBtn.textContent = 'Receive (non-destructive)';
        renderMessages(msg.messages);
      } else if (msg.type === 'tasksResult') {
        renderTasks(msg.tasks);
      } else if (msg.type === 'redriveStarted') {
        // Switch to tasks tab so the user sees the new task.
        var taskTab = document.querySelector('.tab[data-tab="tasks"]');
        if (taskTab) taskTab.click();
      } else if (msg.type === 'error') {
        peekBtn.disabled = false;
        peekBtn.textContent = 'Receive (non-destructive)';
        showError(msg.message || 'Unknown error');
      }
    });
  </script>
</body>
</html>`;
  }
}
