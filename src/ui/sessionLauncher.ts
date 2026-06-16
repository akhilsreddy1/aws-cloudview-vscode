import * as vscode from "vscode";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";

/**
 * Helpers for launching AWS Session Manager interactive sessions from
 * resource rows in the dashboards.
 *
 * We hand off to the user's local AWS CLI in a VS Code integrated terminal
 * rather than proxying I/O ourselves: it uses the user's existing shell
 * credentials, the Session Manager plugin's tunnel, and TTY handling that
 * are all well-tuned for terminals. The same approach is what AWS Toolkit
 * for VS Code does.
 *
 * Prerequisites users need on PATH:
 *   1. `aws` (AWS CLI v2)
 *   2. `session-manager-plugin` (separate install; AWS publishes installers
 *      per OS). Required by `aws ssm start-session` and `aws ecs execute-command`.
 *
 * We don't pre-check those — the terminal output is the clearest place for
 * any "command not found" feedback, and forcing a shell exec to probe would
 * be slower than just letting the launch fail visibly.
 */

/** Resolve the AWS profile that maps to `resource.accountId`, or surface a toast. */
async function profileForResource(
  platform: CloudViewPlatform,
  resource: ResourceNode,
): Promise<string | undefined> {
  const profileName = await platform.sessionManager.findProfileNameByAccountId(resource.accountId);
  if (!profileName) {
    void vscode.window.showWarningMessage(
      `No AWS profile found for account ${resource.accountId}. Add a profile to ~/.aws/config or ~/.aws/credentials and reload profiles.`,
    );
    return undefined;
  }
  return profileName;
}

/**
 * Quote a single CLI argument for POSIX shells. We only ever inject AWS
 * identifiers (instance-id, ARN segments, container names) that almost
 * never need quoting, but ARN parsing could surface unexpected characters.
 * Cheap to be safe.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Open (or reveal) a named VS Code terminal and run a single command line.
 * Each (kind, scope-key) pair gets its own terminal so repeated invocations
 * don't pile up tabs.
 */
function runInTerminal(name: string, command: string): void {
  try {
    const existing = vscode.window.terminals.find((t) => t.name === name);
    const terminal = existing ?? vscode.window.createTerminal({ name });
    terminal.show(true);
    terminal.sendText(command, true);
  } catch {
    void vscode.window.showInformationMessage(
      `Could not open a terminal. Run this command manually — append custom SSM document --document-name <name> if needed:\n\n${command}`,
      { modal: true },
    );
  }
}

/**
 * Launch `aws ssm start-session` against an EC2 instance.
 *
 * Requires the instance to have the SSM Agent + an instance profile with
 * `AmazonSSMManagedInstanceCore` (or equivalent). If those are missing the
 * CLI prints a clear "TargetNotConnected" error in the terminal.
 */
export async function launchEc2SsmSession(
  platform: CloudViewPlatform,
  resource: ResourceNode,
  documentName?: string,
): Promise<void> {
  const instanceId = (resource.rawJson.InstanceId as string | undefined) ?? resource.id;
  const state = (resource.rawJson.State as { Name?: string } | undefined)?.Name;
  if (state && state !== "running") {
    void vscode.window.showWarningMessage(
      `Instance ${instanceId} is in state "${state}". Session Manager only connects to running instances.`,
    );
    return;
  }
  const profileName = await profileForResource(platform, resource);
  if (!profileName) return;

  const cmdParts = [
    "aws", "ssm", "start-session",
    "--target", shellQuote(instanceId),
    "--profile", shellQuote(profileName),
    "--region", shellQuote(resource.region),
  ];
  if (documentName) {
    cmdParts.push("--document-name", shellQuote(documentName));
  }
  const cmd = cmdParts.join(" ");

  runInTerminal(`SSM: ${instanceId}`, cmd);
}

/**
 * Launch `aws ecs execute-command` against a running ECS task. If the task
 * has multiple containers, a quick-pick lets the user choose; single-
 * container tasks skip the prompt.
 *
 * The task's service / task-definition must have been deployed with
 * `enableExecuteCommand: true`. We surface a clear warning if the cached
 * flag isn't set so users aren't confused by the eventual server-side
 * "execute-command not enabled" error.
 */
export async function launchEcsExec(
  platform: CloudViewPlatform,
  resource: ResourceNode,
): Promise<void> {
  const raw = resource.rawJson as Record<string, unknown>;
  const lastStatus = String(raw.lastStatus ?? "").toUpperCase();
  if (lastStatus !== "RUNNING") {
    void vscode.window.showWarningMessage(
      `Task ${resource.id} is "${lastStatus || "unknown"}". Exec only works on RUNNING tasks.`,
    );
    return;
  }
  if (raw.enableExecuteCommand !== true) {
    const choice = await vscode.window.showWarningMessage(
      "This task's service was not deployed with `enableExecuteCommand: true`. The session will likely fail. Continue anyway?",
      { modal: true },
      "Continue anyway",
    );
    if (choice !== "Continue anyway") return;
  }

  // Cluster ARN → cluster name.
  const clusterArn = raw.clusterArn as string | undefined;
  const clusterName = clusterArn ? clusterArn.split("/").pop() ?? clusterArn : "";
  if (!clusterName) {
    void vscode.window.showWarningMessage("Could not determine the ECS cluster for this task.");
    return;
  }

  // Pick a container — quick-pick if more than one.
  const containers =
    (raw.ContainersSummary as Array<{ name?: string; lastStatus?: string }> | undefined) ?? [];
  let containerName: string | undefined;
  if (containers.length <= 1) {
    containerName = containers[0]?.name;
  } else {
    const picked = await vscode.window.showQuickPick(
      containers
        .filter((c) => c.name)
        .map((c) => ({
          label: c.name!,
          description: c.lastStatus ?? "",
        })),
      { title: `Exec into container in ${resource.id}`, placeHolder: "Pick a container" },
    );
    if (!picked) return;
    containerName = picked.label;
  }
  if (!containerName) {
    void vscode.window.showWarningMessage("This task has no containers visible in the local cache.");
    return;
  }

  const profileName = await profileForResource(platform, resource);
  if (!profileName) return;

  // Default to `/bin/sh` — universally available; users can re-exec `bash`
  // inside if they need it.
  const cmd = [
    "aws", "ecs", "execute-command",
    "--cluster", shellQuote(clusterName),
    "--task", shellQuote(resource.id),
    "--container", shellQuote(containerName),
    "--interactive",
    "--command", "\"/bin/sh\"",
    "--profile", shellQuote(profileName),
    "--region", shellQuote(resource.region),
  ].join(" ");

  runInTerminal(`ECS exec: ${containerName}`, cmd);
}
