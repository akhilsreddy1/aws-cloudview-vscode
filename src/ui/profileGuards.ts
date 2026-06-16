import * as vscode from "vscode";
import type { CloudViewPlatform } from "../core/platform";
import type { AwsProfileSession } from "../core/contracts";

/**
 * Resolve the user's currently-selected AWS sessions, or surface a
 * specifically-correct error message when the result is empty.
 *
 * Two distinct empty-states get conflated by naive callers:
 *   1. Zero profiles are stored in selection state (user hasn't picked yet).
 *   2. Profiles are stored, but every one of them failed to resolve
 *      (expired SSO, invalid keys, network error, etc.).
 *
 * Telling a user with selected-but-broken profiles to "select a profile"
 * is misleading — they already did. This helper points them at the Output
 * channel and the Reload Profiles command, which is what they actually need.
 *
 * @returns the resolved sessions, or `undefined` when the caller should bail
 *   out (the user has been notified). Callers must early-return on
 *   `undefined`.
 */
export async function requireSelectedSessions(
  platform: CloudViewPlatform,
  context: string,
): Promise<AwsProfileSession[] | undefined> {
  const sessions = await platform.sessionManager.getSelectedProfileSessions();
  if (sessions.length > 0) return sessions;

  const stored = await platform.sessionManager.getSelectedProfiles();
  if (stored.length === 0) {
    void vscode.window.showInformationMessage(
      `Select an AWS profile to ${context} (CloudView: Select AWS Profiles).`,
    );
    return undefined;
  }

  // All stored profiles failed to resolve. The classified per-profile reason
  // was already logged at warn level inside `getSelectedProfileSessions`.
  // Show a single notification with affordances to view the log or re-auth.
  const action = await vscode.window.showWarningMessage(
    `Selected profile${stored.length === 1 ? "" : "s"} (${stored.join(", ")}) failed to resolve. Common causes: expired SSO/STS tokens, invalid keys, network/proxy issues. Check the Output channel and click "Reload AWS Profiles" after re-authing.`,
    "Show Logs",
    "Reload Profiles",
    "Pick Different Profiles",
  );
  if (action === "Show Logs") {
    await vscode.commands.executeCommand("workbench.action.output.toggleOutput");
  } else if (action === "Reload Profiles") {
    await vscode.commands.executeCommand("cloudView.refreshProfiles");
  } else if (action === "Pick Different Profiles") {
    await vscode.commands.executeCommand("cloudView.selectProfile");
  }
  return undefined;
}
