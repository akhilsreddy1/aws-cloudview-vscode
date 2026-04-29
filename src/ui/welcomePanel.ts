import * as vscode from "vscode";
import { generateNonce, buildCsp, AWS_ICONS, DEFAULT_ICON } from "../views/webviewToolkit";

export class WelcomePanel {
  private static instance: WelcomePanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewWelcome",
      "CloudView for AWS",
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: false },
    );

    this.panel.onDidDispose(() => {
      WelcomePanel.instance = undefined;
    });

    this.panel.webview.html = this.buildHtml();
  }

  public static open(context: vscode.ExtensionContext): void {
    if (WelcomePanel.instance) {
      WelcomePanel.instance.panel.reveal();
      return;
    }
    WelcomePanel.instance = new WelcomePanel(context);
  }

  private buildHtml(): string {
    const n = generateNonce();

    const services: Array<{ key: string; label: string }> = [
      { key: "lambda", label: "Lambda" },
      { key: "ec2", label: "EC2" },
      { key: "s3", label: "S3" },
      { key: "rds", label: "Databases" },
      { key: "ecs", label: "ECS" },
      { key: "vpc", label: "VPC" },
      { key: "dynamodb", label: "DynamoDB" },
      { key: "stepfunctions", label: "Step Functions" },
      { key: "eventbridge", label: "EventBridge" },
      { key: "ecr", label: "ECR" },
      { key: "redshift", label: "Redshift" },
      { key: "msk", label: "MSK" },
      { key: "cloudformation", label: "CloudFormation" },
      { key: "logs", label: "CloudWatch Logs" },
    ];

    const serviceChipsHtml = services.map((s) => {
      const icon = AWS_ICONS[s.key] ?? DEFAULT_ICON;
      return `<div class="chip"><div class="chip-icon">${icon}</div><span>${s.label}</span></div>`;
    }).join("");

    const features: Array<{ title: string; desc: string }> = [
      { title: "Rich web UI per resource", desc: "Every resource opens in a full VS Code webview: layouts, tables, metadata, tabs, search, export, and actions matched to that resource type—not just a tree row." },
      { title: "Service dashboards",       desc: "Service-level webviews with sortable tables, stats, and the same polished HTML experience across supported AWS services." },
      { title: "Actions & commands",       desc: "Lambda invoke, S3 browse, ECR image views, Step Functions invoke, and more from context menus and the Command Palette." },
      { title: "Resource graph",           desc: "Interactive visualization of how VPCs, subnets, load balancers, databases, and compute connect." },
      { title: "Local Database",           desc: "Resources are cached in a local SQLite database for quick access and offline viewing and dynamically refreshed when user refreshes and reconciled when partial cache is available. Ability to clear the database to start fresh when needed." },
    ];

    const featureCardsHtml = features.map((f) => `
      <div class="feat">
        <div class="feat-title">${f.title}</div>
        <div class="feat-desc">${f.desc}</div>
      </div>
    `).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildCsp(n, [], [this.panel.webview.cspSource])}">
  <title>CloudView for AWS</title>
  <style>
    :root {
      --bg: #000000;
      --bg-elev: #0d0d0f;
      --bg-elev-2: #141418;
      --border: #1f1f24;
      --border-strong: #2a2a30;
      --text: #f5f5f7;
      --text-dim: #a0a0a8;
      --text-muted: #65656d;
      --accent: #ff9900;
      --accent-soft: rgba(255, 153, 0, 0.12);
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    .wrap { max-width: 1120px; margin: 0 auto; padding: 64px 32px 80px; }

    /* ── Hero ─────────────────────────────────────── */
    .hero { margin-bottom: 72px; }
    .hero-badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      background: var(--accent-soft);
      border: 1px solid rgba(255, 153, 0, 0.25);
      border-radius: 999px;
      font-size: 11px; font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.06em; text-transform: uppercase;
      margin-bottom: 20px;
    }
    .hero-badge::before {
      content: ""; width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent); box-shadow: 0 0 8px var(--accent);
    }
    .hero h1 {
      font-size: 44px; font-weight: 800;
      letter-spacing: -1.2px;
      margin: 0 0 18px;
      line-height: 1.1;
    }
    .hero h1 .accent { color: var(--accent); }
    .hero p {
      font-size: 16px; color: var(--text-dim);
      max-width: 620px;
      margin: 0;
      line-height: 1.6;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px 48px;
      align-items: start;
    }
    .two-col .col .section-intro { max-width: none; }

    /* ── Section ─────────────────────────────────────── */
    .section { margin-bottom: 64px; }
    .section-label {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 20px;
      display: flex; align-items: center; gap: 10px;
    }
    .section-label::after {
      content: ""; flex: 1; height: 1px; background: var(--border);
    }
    .section h2 {
      font-size: 24px; font-weight: 700;
      letter-spacing: -0.4px;
      margin: 0 0 8px;
    }
    .section-intro {
      color: var(--text-dim); margin: 0 0 28px; max-width: 580px;
      font-size: 14px;
    }

    /* ── Features grid ─────────────────────────────────────── */
    .feat-grid {
      display: grid; grid-template-columns: 1fr; gap: 12px;
    }
    .feat {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 22px;
      transition: border-color .18s ease, background .18s ease, transform .18s ease;
    }
    .feat:hover {
      border-color: var(--border-strong);
      background: var(--bg-elev-2);
      transform: translateY(-1px);
    }
    .feat-title {
      font-size: 14px; font-weight: 700; color: var(--text);
      margin-bottom: 6px;
      letter-spacing: -0.1px;
    }
    .feat-desc {
      font-size: 13px; color: var(--text-dim); line-height: 1.55;
    }

    /* ── Usage steps ─────────────────────────────────────── */
    .steps { display: flex; flex-direction: column; gap: 12px; }
    .step {
      display: flex; gap: 18px;
      padding: 20px 22px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      align-items: flex-start;
      transition: border-color .18s ease, background .18s ease;
    }
    .step:hover { border-color: var(--border-strong); background: var(--bg-elev-2); }
    .step-num {
      flex-shrink: 0;
      width: 32px; height: 32px;
      border-radius: 8px;
      background: var(--accent-soft);
      color: var(--accent);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px;
      border: 1px solid rgba(255, 153, 0, 0.25);
    }
    .step-body { flex: 1; min-width: 0; }
    .step-title {
      font-size: 15px; font-weight: 700; color: var(--text);
      margin-bottom: 4px; letter-spacing: -0.1px;
    }
    .step-desc { font-size: 13px; color: var(--text-dim); line-height: 1.55; margin: 0; }

    /* ── Service chips ─────────────────────────────────────── */
    .chips {
      display: flex; flex-wrap: wrap; gap: 8px;
    }
    .chip {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px 8px 10px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12px; font-weight: 600;
      color: var(--text-dim);
      transition: border-color .15s ease, color .15s ease, background .15s ease;
    }
    .chip:hover { border-color: var(--border-strong); color: var(--text); background: var(--bg-elev-2); }
    .chip-icon {
      width: 18px; height: 18px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .chip-icon svg { width: 18px; height: 18px; }

    /* ── Footer ─────────────────────────────────────── */
    .footer {
      margin-top: 64px;
      padding-top: 28px;
      border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; color: var(--text-muted);
    }
    .footer strong { color: var(--text-dim); font-weight: 600; }
    kbd {
      display: inline-block;
      padding: 2px 6px;
      background: var(--bg-elev-2);
      border: 1px solid var(--border-strong);
      border-bottom-width: 2px;
      border-radius: 4px;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 11px; color: var(--text-dim);
    }

    @media (max-width: 900px) {
      .two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .wrap { padding: 40px 20px 60px; }
      .hero h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <div class="wrap">

    <!-- Hero -->
    <section class="hero">
      <h1>Your AWS account inside <span class="accent">VS Code</span></h1>
      <p>CloudView discovers every resource across your AWS profiles and regions, maps how they relate, and opens each one in a <strong>rich web UI</strong> so you can inspect, search, and invoke — without ever leaving the editor.</p>
    </section>

    <!-- Usage | Features -->
    <section class="section">
      <div class="two-col">
        <div class="col col-usage">
          <div class="section-label">Usage</div>
          <h2>Three steps to running.</h2>
          <p class="section-intro">Open CloudView, pick your accounts and regions, then refresh. Everything else is available from the sidebar and Command Palette.</p>
          <div class="steps">
            <div class="step">
              <div class="step-num">1</div>
              <div class="step-body">
                <div class="step-title">Select AWS profiles</div>
                <div class="step-desc">Pick one or more AWS profiles from the sidebar,which will be used to discover resource.IAM or role based authentication is supported.</div>
              </div>
            </div>
            <div class="step">
              <div class="step-num">2</div>
              <div class="step-body">
                <div class="step-title">Toggle regions</div>
                <div class="step-desc">Enable only the regions you care about from the Region panel in the sidebar</div>
              </div>
            </div>
            <div class="step">
              <div class="step-num">3</div>
              <div class="step-body">
                <div class="step-title">Discover &amp; explore</div>
                <div class="step-desc">Refresh to scan every service in parallel. Click a service for a dashboard webview, a resource for its rich detail webview, or the graph icon to visualize relationships.</div>
              </div>
            </div>
            <div class="step">
              <div class="step-num">4</div>
              <div class="step-body">
                <div class="step-title">Clear Local Database</div>
                <div class="step-desc">Clear the local SQLite database to start fresh, when you need it</div>
              </div>
            </div>
          </div>
        </div>
        <div class="col col-features">
          <div class="section-label">Features</div>
          <h2>Supported services and features.</h2>
          <p class="section-intro">Supported services and features are listed below.</p>
          <div class="feat-grid">
            ${featureCardsHtml}
          </div>
        </div>
      </div>
    </section>

    <!-- Supported services -->
    <section class="section">
      <div class="section-label">Services</div>
      <h2>Coverage across your stack.</h2>
      <p class="section-intro">From compute and storage to queues, logs, and infrastructure-as-code.</p>
      <div class="chips">
        ${serviceChipsHtml}
      </div>
    </section>

    <!-- Footer -->
    <div class="footer">
      <span>Open the Command Palette <kbd>\u2318\u21e7P</kbd> and type <strong>CloudView:</strong> to access every command.</span>
      <span>CloudView for AWS</span>
    </div>

  </div>
</body>
</html>`;
  }
}
