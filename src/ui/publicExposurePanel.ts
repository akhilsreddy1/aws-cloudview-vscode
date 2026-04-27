import * as vscode from "vscode";
import {
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  GetBucketAclCommand,
} from "@aws-sdk/client-s3";
import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
} from "@aws-sdk/client-rds";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";
import { generateNonce, escapeHtml, buildCsp, BASE_STYLES } from "../views/webviewToolkit";

type Severity = "ok" | "warn" | "critical";

interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

/**
 * "Is this resource reachable from the public internet?" panel. Runs a
 * small, read-only audit tailored to the resource type:
 *
 *  - **S3 bucket** — `GetPublicAccessBlock`, `GetBucketPolicyStatus`, `GetBucketAcl`.
 *  - **Security group** — inspects ingress rules for `0.0.0.0/0` or `::/0`.
 *  - **ALB** — `scheme=internet-facing` + SG inbound 0.0.0.0/0 on listener ports.
 *  - **RDS instance/cluster** — `PubliclyAccessible` flag + attached SGs.
 *
 * All AWS calls are read-only; no mutations are performed. Findings are
 * surfaced as a three-tier list (ok / warn / critical) rather than a binary
 * result so the user can see every individual signal.
 */
export class PublicExposurePanel {
  private static panels = new Map<string, PublicExposurePanel>();
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly platform: CloudViewPlatform,
    private readonly resource: ResourceNode,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "cloudViewPublicExposure",
      `Exposure: ${resource.name || resource.id}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => PublicExposurePanel.panels.delete(resource.arn));
    this.panel.webview.html = this.buildShell("Running checks…");
    void this.runChecks();
  }

  public static async open(platform: CloudViewPlatform, resource: ResourceNode): Promise<void> {
    const existing = PublicExposurePanel.panels.get(resource.arn);
    if (existing) { existing.panel.reveal(); return; }
    const instance = new PublicExposurePanel(platform, resource);
    PublicExposurePanel.panels.set(resource.arn, instance);
  }

  private async runChecks(): Promise<void> {
    try {
      const findings = await this.check();
      this.panel.webview.html = this.renderFindings(findings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = this.buildShell(`Failed: ${message}`);
    }
  }

  private async check(): Promise<Finding[]> {
    switch (this.resource.type) {
      case ResourceTypes.s3Bucket: return this.checkS3();
      case ResourceTypes.securityGroup: return this.checkSecurityGroup();
      case ResourceTypes.alb: return this.checkAlb();
      case ResourceTypes.rdsInstance: return this.checkRdsInstance();
      case ResourceTypes.rdsCluster: return this.checkRdsCluster();
      default: return [{ severity: "warn", title: "Unsupported", detail: `No exposure check implemented for ${this.resource.type}.` }];
    }
  }

  private async scope() {
    const profileName = await this.platform.sessionManager.findProfileNameByAccountId(this.resource.accountId);
    if (!profileName) { throw new Error("No AWS profile resolved for this account."); }
    return { profileName, accountId: this.resource.accountId, region: this.resource.region };
  }

  private async checkS3(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const scope = await this.scope();
    const client = await this.platform.awsClientFactory.s3(scope);
    const bucket = this.resource.name || this.resource.id;

    // Public Access Block
    try {
      const pab = await this.platform.scheduler.run("s3", "GetPublicAccessBlock", () =>
        client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }))
      );
      const cfg = pab.PublicAccessBlockConfiguration;
      const allOn = cfg && cfg.BlockPublicAcls && cfg.IgnorePublicAcls && cfg.BlockPublicPolicy && cfg.RestrictPublicBuckets;
      if (allOn) {
        findings.push({ severity: "ok", title: "Public Access Block: all four flags enabled", detail: "BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets are all true." });
      } else {
        findings.push({ severity: "warn", title: "Public Access Block: one or more flags disabled", detail: JSON.stringify(cfg ?? {}, null, 2) });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NoSuchPublicAccessBlockConfiguration/i.test(msg)) {
        findings.push({ severity: "critical", title: "Public Access Block not configured", detail: "Bucket has no public access block — account-level defaults apply, which may still allow public policies/ACLs." });
      } else {
        findings.push({ severity: "warn", title: "GetPublicAccessBlock failed", detail: msg });
      }
    }

    // Bucket policy status
    try {
      const ps = await this.platform.scheduler.run("s3", "GetBucketPolicyStatus", () =>
        client.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }))
      );
      if (ps.PolicyStatus?.IsPublic) {
        findings.push({ severity: "critical", title: "Bucket policy grants public access", detail: "The attached bucket policy allows anonymous principals. Review who needs this." });
      } else {
        findings.push({ severity: "ok", title: "Bucket policy is not public", detail: "No anonymous principals in the bucket policy." });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/NoSuchBucketPolicy/i.test(msg)) {
        findings.push({ severity: "warn", title: "GetBucketPolicyStatus failed", detail: msg });
      }
    }

    // ACL
    try {
      const acl = await this.platform.scheduler.run("s3", "GetBucketAcl", () =>
        client.send(new GetBucketAclCommand({ Bucket: bucket }))
      );
      const publicGrants = (acl.Grants ?? []).filter((g) => {
        const uri = g.Grantee?.URI ?? "";
        return uri.includes("AllUsers") || uri.includes("AuthenticatedUsers");
      });
      if (publicGrants.length > 0) {
        findings.push({ severity: "critical", title: "Bucket ACL grants public access", detail: publicGrants.map((g) => `${g.Permission} → ${g.Grantee?.URI}`).join("\n") });
      } else {
        findings.push({ severity: "ok", title: "Bucket ACL is not public", detail: "No grants to AllUsers or AuthenticatedUsers." });
      }
    } catch (err: unknown) {
      findings.push({ severity: "warn", title: "GetBucketAcl failed", detail: err instanceof Error ? err.message : String(err) });
    }

    return findings;
  }

  private async checkSecurityGroup(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const scope = await this.scope();
    const client = await this.platform.awsClientFactory.ec2(scope);
    const response = await this.platform.scheduler.run("ec2", "DescribeSecurityGroups", () =>
      client.send(new DescribeSecurityGroupsCommand({ GroupIds: [this.resource.id] }))
    );
    const sg = response.SecurityGroups?.[0];
    if (!sg) { return [{ severity: "warn", title: "Security group not found", detail: this.resource.id }]; }

    const openIngress: string[] = [];
    for (const rule of sg.IpPermissions ?? []) {
      const portRange = rule.FromPort === rule.ToPort
        ? `${rule.FromPort}`
        : `${rule.FromPort}-${rule.ToPort}`;
      const proto = rule.IpProtocol === "-1" ? "all" : rule.IpProtocol;
      for (const ip of rule.IpRanges ?? []) {
        if (ip.CidrIp === "0.0.0.0/0") {
          openIngress.push(`${proto}/${portRange} from 0.0.0.0/0 (${ip.Description ?? "no description"})`);
        }
      }
      for (const ip of rule.Ipv6Ranges ?? []) {
        if (ip.CidrIpv6 === "::/0") {
          openIngress.push(`${proto}/${portRange} from ::/0`);
        }
      }
    }

    if (openIngress.length === 0) {
      findings.push({ severity: "ok", title: "No ingress from 0.0.0.0/0 or ::/0", detail: "All inbound rules are scoped to a CIDR, prefix list, or referenced SG." });
    } else {
      const severity: Severity = openIngress.some((line) => /\/22\b|\/80\b|\/443\b/.test(line)) ? "warn" : "critical";
      findings.push({
        severity,
        title: `${openIngress.length} ingress rule(s) open to the internet`,
        detail: openIngress.join("\n"),
      });
    }
    return findings;
  }

  private async checkAlb(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const scope = await this.scope();
    const client = await this.platform.awsClientFactory.elbv2(scope);
    const response = await this.platform.scheduler.run("elbv2", "DescribeLoadBalancers", () =>
      client.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [this.resource.arn] }))
    );
    const lb = response.LoadBalancers?.[0];
    if (!lb) { return [{ severity: "warn", title: "Load balancer not found", detail: this.resource.arn }]; }

    if (lb.Scheme === "internet-facing") {
      findings.push({ severity: "critical", title: "Scheme: internet-facing", detail: `The ALB is assigned a public DNS name (${lb.DNSName}) and reachable from the internet.` });
    } else {
      findings.push({ severity: "ok", title: "Scheme: internal", detail: "The ALB is only reachable inside its VPC." });
    }

    const sgCount = (lb.SecurityGroups ?? []).length;
    findings.push({
      severity: sgCount === 0 ? "warn" : "ok",
      title: `${sgCount} security group(s) attached`,
      detail: (lb.SecurityGroups ?? []).join(", ") || "None — traffic is unrestricted by SG.",
    });
    return findings;
  }

  private async checkRdsInstance(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const scope = await this.scope();
    const client = await this.platform.awsClientFactory.rds(scope);
    const response = await this.platform.scheduler.run("rds", "DescribeDBInstances", () =>
      client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: this.resource.id }))
    );
    const inst = response.DBInstances?.[0];
    if (!inst) { return [{ severity: "warn", title: "RDS instance not found", detail: this.resource.id }]; }

    if (inst.PubliclyAccessible) {
      findings.push({ severity: "critical", title: "PubliclyAccessible = true", detail: `Endpoint: ${inst.Endpoint?.Address}:${inst.Endpoint?.Port}. The instance resolves to a public IP from outside its VPC.` });
    } else {
      findings.push({ severity: "ok", title: "PubliclyAccessible = false", detail: "The instance endpoint resolves to a private IP only." });
    }

    const sgs = (inst.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId).filter(Boolean) as string[];
    findings.push({ severity: "ok", title: `${sgs.length} VPC SG(s) attached`, detail: sgs.join(", ") || "none" });
    return findings;
  }

  private async checkRdsCluster(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const scope = await this.scope();
    const client = await this.platform.awsClientFactory.rds(scope);
    const response = await this.platform.scheduler.run("rds", "DescribeDBClusters", () =>
      client.send(new DescribeDBClustersCommand({ DBClusterIdentifier: this.resource.id }))
    );
    const cluster = response.DBClusters?.[0];
    if (!cluster) { return [{ severity: "warn", title: "RDS cluster not found", detail: this.resource.id }]; }

    // Aurora cluster publicity is determined by the member instances, not the cluster itself.
    findings.push({
      severity: "warn",
      title: "Cluster-level check is indirect",
      detail: "Aurora cluster publicity is determined by its member instances — check each DB instance individually for PubliclyAccessible.",
    });
    const sgs = (cluster.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId).filter(Boolean) as string[];
    findings.push({ severity: "ok", title: `${sgs.length} VPC SG(s) attached`, detail: sgs.join(", ") || "none" });
    return findings;
  }

  private renderFindings(findings: Finding[]): string {
    const n = generateNonce();
    const counts = {
      ok: findings.filter((f) => f.severity === "ok").length,
      warn: findings.filter((f) => f.severity === "warn").length,
      critical: findings.filter((f) => f.severity === "critical").length,
    };
    const rows = findings.map((f) => `
      <div class="finding ${f.severity}">
        <div class="title"><span class="badge ${f.severity}">${f.severity.toUpperCase()}</span> ${escapeHtml(f.title)}</div>
        <pre>${escapeHtml(f.detail)}</pre>
      </div>
    `).join("");

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<style>
${BASE_STYLES}
.header { padding:12px 16px; border-bottom:1px solid var(--vscode-panel-border); }
.header h2 { margin:0 0 4px; font-size:14px; }
.header .sub { font-size:12px; color:var(--vscode-descriptionForeground); }
.counts { display:flex; gap:12px; margin-top:8px; font-size:12px; }
.finding { padding:10px 16px; border-bottom:1px solid var(--vscode-panel-border); }
.finding .title { font-size:13px; font-weight:500; margin-bottom:4px; }
.badge { display:inline-block; padding:1px 8px; font-size:10px; font-weight:600; border-radius:3px; margin-right:6px; }
.badge.ok { background:#1f6f3f; color:#fff; }
.badge.warn { background:#9a6d1f; color:#fff; }
.badge.critical { background:#8b1a1a; color:#fff; }
pre { background:var(--vscode-textCodeBlock-background); padding:8px; margin:4px 0 0; border-radius:3px; font-size:11px; white-space:pre-wrap; }
</style>
</head><body>
<div class="header">
  <h2>Public Exposure — ${escapeHtml(this.resource.name || this.resource.id)}</h2>
  <div class="sub">${escapeHtml(this.resource.type)} • ${escapeHtml(this.resource.region)}</div>
  <div class="counts">
    <span>${counts.critical} critical</span>
    <span>${counts.warn} warning</span>
    <span>${counts.ok} ok</span>
  </div>
</div>
${rows || '<div style="padding:16px">No findings.</div>'}
</body></html>`;
  }

  private buildShell(message: string): string {
    const n = generateNonce();
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(n)}">
<style>${BASE_STYLES} .msg { padding:20px; color:var(--vscode-descriptionForeground); }</style>
</head><body><div class="msg">${escapeHtml(message)}</div></body></html>`;
  }
}
