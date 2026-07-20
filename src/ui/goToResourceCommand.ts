import * as vscode from "vscode";
import type { CloudViewPlatform } from "../core/platform";
import type { ResourceNode } from "../core/contracts";
import { getServiceViewConfig } from "./serviceColumnConfig";
import { ServiceDetailPanel } from "./serviceDetailPanel";
import { requireSelectedSessions } from "./profileGuards";

/**
 * "Go to resource" — a global command-palette-driven quick-pick over every
 * resource cached in the local SQLite DB, across all services and the
 * currently-selected accounts. Pure local query (no AWS API calls); typing
 * fuzzy-filters on name / ARN / type / region / tags.
 *
 * On selection we open the target's service dashboard and post a
 * `focusResource` message so the drawer auto-opens on the picked row —
 * one click gets you from anywhere in VS Code to the resource's detail
 * view, with actions ready.
 */
interface ResourceQuickPickItem extends vscode.QuickPickItem {
  resource: ResourceNode;
}

/** Build the description string shown to the right of the item's name. */
function describeResource(r: ResourceNode): string {
  const parts: string[] = [];
  // Short service.type e.g. "ec2.instance"
  const typeShort = r.type.replace(/^aws\./, "");
  parts.push(typeShort);
  if (r.id && r.id !== r.name) parts.push(r.id);
  if (r.region) parts.push(r.region);
  return parts.join(" · ");
}

/**
 * Build the searchable-detail line. VS Code's quick pick fuzzy-matches on
 * `detail` when `matchOnDetail: true`, so packing ARN + tag key/value pairs
 * in here makes both directly searchable.
 */
function detailForResource(r: ResourceNode): string {
  const bits: string[] = [];
  if (r.arn) bits.push(r.arn);
  const tagKeys = Object.keys(r.tags ?? {});
  if (tagKeys.length > 0) {
    const tagSummary = tagKeys
      .slice(0, 6)
      .map((k) => `${k}=${r.tags[k]}`)
      .join(", ");
    bits.push(`tags: ${tagSummary}${tagKeys.length > 6 ? ` (+${tagKeys.length - 6} more)` : ""}`);
  }
  bits.push(`account ${r.accountId}`);
  return bits.join(" · ");
}

export async function showGoToResource(platform: CloudViewPlatform): Promise<void> {
  const sessions = await requireSelectedSessions(platform, 'run "Go to resource"');
  if (!sessions) return;

  const accountIds = [...new Set(sessions.map((s) => s.accountId))];

  // Pull everything cached for the selected accounts. Cheap — this is one
  // SQLite scan and there's no AWS round-trip.
  const resources = await platform.resourceRepo.listByAccounts(accountIds);

  if (resources.length === 0) {
    void vscode.window.showInformationMessage(
      "No resources in the local cache yet. Run CloudView: Refresh Resources first.",
    );
    return;
  }

  // Sort by service then name so scrolling the palette is predictable.
  resources.sort((a, b) => {
    const s = a.service.localeCompare(b.service);
    if (s !== 0) return s;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });

  const items: ResourceQuickPickItem[] = resources.map((r) => ({
    label: r.name || r.id,
    description: describeResource(r),
    detail: detailForResource(r),
    resource: r,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Go to resource — ${resources.length} across ${accountIds.length} account${accountIds.length === 1 ? "" : "s"}`,
    placeHolder: "Type name, ARN, region, tag key=value…",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: false,
  });
  if (!picked) return;

  const target = picked.resource;

  // Resolve the dashboard's service key from the resource's service. If the
  // resource type isn't covered by a dashboard config (e.g. a synthetic
  // resource type), fall back to just showing the ARN.
  const serviceKey = target.service;
  if (!getServiceViewConfig(serviceKey)) {
    void vscode.window.showInformationMessage(
      `No dashboard is configured for "${serviceKey}". Copied ARN to clipboard instead.`,
    );
    await vscode.env.clipboard.writeText(target.arn);
    return;
  }

  // Region set: use the resource's own region so the dashboard shows the
  // scope containing it, not the currently-selected sidebar regions.
  await ServiceDetailPanel.openMultiScope(
    platform,
    serviceKey,
    accountIds,
    [target.region],
    { focusArn: target.arn },
  );
}
