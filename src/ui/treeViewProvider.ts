import * as vscode from "vscode";
import * as path from "node:path";
import type { CloudViewPlatform } from "../core/platform";

// ── Shared icon map: serviceId → SVG filename in media/icons/ ────────────────
const SERVICE_ICON_MAP: Record<string, string> = {
  s3: "s3.svg",
  lambda: "lambda.svg",
  ec2: "ec2.svg",
  vpc: "vpc.svg",
  ecs: "ecs.svg",
  ecr: "ecr.svg",
  rds: "rds.svg",
  dynamodb: "dynamodb.svg",
  redshift: "redshift.svg",
  eventbridge: "eventbridge.svg",
  msk: "msk.svg",
  cloudformation: "cloudformation.svg",
  stepfunctions: "stepfunctions.svg",
  logs: "logs.svg",
  sqs: "sqs.svg",
  athena: "athena.svg",
};

// Preferred display order for services in the sidebar
const SERVICE_DISPLAY_ORDER = [
  "athena", "cloudformation", "dynamodb", "ec2", "ecr", "ecs", "eventbridge", "lambda", "logs", "msk", "rds", "redshift", "s3", "stepfunctions", "vpc", "sqs",
];

/**
 * Synthetic tree entries — services that don't have a discovery plugin (no
 * registry entry, no SQLite resource rows) but should still surface in the
 * sidebar as launchers for a dedicated panel. Each entry's `command` is
 * dispatched on click instead of the default `cloudView.openServiceDetail`.
 */
interface ExternalServiceEntry {
  serviceId: string;
  serviceLabel: string;
  command: string;
  /** Lower number sorts earlier; placed at the bottom by default. */
  order?: number;
}

const EXTERNAL_SERVICES: ExternalServiceEntry[] = [
  {
    serviceId: "athena",
    serviceLabel: "Athena (Query)",
    command: "cloudView.athena.openQueryRunner",
  },
];

// ── Region geographic grouping ───────────────────────────────────────────────
interface RegionGroup {
  label: string;
  regions: string[];
}

const REGION_GROUPS: RegionGroup[] = [
  {
    label: "US East",
    regions: ["us-east-1", "us-east-2"],
  },
  {
    label: "US West",
    regions: ["us-west-1", "us-west-2"],
  },
  {
    label: "Europe",
    regions: ["eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2"],
  },
  {
    label: "Asia Pacific",
    regions: ["ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-east-1"],
  },
];

// ── Node types ───────────────────────────────────────────────────────────────

export interface ServiceTreeNode {
  kind: "service";
  serviceId: string;
  serviceLabel: string;
  /**
   * Optional command override for synthetic entries (Athena, etc.) that don't
   * have discovered resources to power a service-detail dashboard. When set,
   * the tree-item click dispatches this command instead of
   * `cloudView.openServiceDetail`.
   */
  externalCommand?: string;
}

export interface RegionGroupTreeNode {
  kind: "regionGroup";
  label: string;
  regions: string[];
}

export interface RegionTreeNode {
  kind: "region";
  region: string;
  selected: boolean;
}

export interface ProfileTreeNode {
  kind: "profile";
  name: string;
  region?: string;
  selected: boolean;
}

// ── 1) Services Tree ─────────────────────────────────────────────────────────

export class ServiceTreeProvider implements vscode.TreeDataProvider<ServiceTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ServiceTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly platform: CloudViewPlatform) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: ServiceTreeNode): vscode.TreeItem {
    // This is the tree item for the service node in the services tree view.
    // It will show the service label and the icon for the service.
    // It will also show the command to open the service detail panel.
    const item = new vscode.TreeItem(element.serviceLabel, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "cloudView.service";

    const iconFile = SERVICE_ICON_MAP[element.serviceId];
    if (iconFile) {
      const iconUri = vscode.Uri.file(
        path.join(this.platform.extensionContext.extensionPath, "media", "icons", iconFile)
      );
      item.iconPath = iconUri;
    } else {
      item.iconPath = new vscode.ThemeIcon("server-environment");
    }

    if (element.externalCommand) {
      // Synthetic node — bypass the dashboard and run the override command.
      // The command receives no arguments (panel decides scope itself).
      item.command = {
        command: element.externalCommand,
        title: element.serviceLabel,
      };
    } else {
      item.command = {
        command: "cloudView.openServiceDetail",
        title: "Open Service Dashboard",
        arguments: [element],
      };
    }

    return item;
  }

  public getChildren(): ServiceTreeNode[] {
    const registered = this.platform.resourceRegistry.listServices();
    const serviceMap = new Map(registered.map((s) => [s.id, s.label]));

    const ordered: ServiceTreeNode[] = [];
    // Append synthetic entries at the beginning.
    for (const ext of EXTERNAL_SERVICES) {
      ordered.push({
        kind: "service",
        serviceId: ext.serviceId,
        serviceLabel: ext.serviceLabel,
        externalCommand: ext.command,
      });
    }
    // Append real services in display order.
    for (const id of SERVICE_DISPLAY_ORDER) {
      const label = serviceMap.get(id);
      if (label) {
        ordered.push({ kind: "service", serviceId: id, serviceLabel: label });
        serviceMap.delete(id);
      }
    }
    for (const [id, label] of serviceMap) {
      ordered.push({ kind: "service", serviceId: id, serviceLabel: label });
    }



    return ordered;
  }
}

// ── 2) Region Tree ───────────────────────────────────────────────────────────

type RegionNode = RegionGroupTreeNode | RegionTreeNode;

export class RegionTreeProvider implements vscode.TreeDataProvider<RegionNode> {
  private readonly emitter = new vscode.EventEmitter<RegionNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private selectedRegions = new Set<string>();

  public constructor(private readonly platform: CloudViewPlatform) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public async loadSelected(): Promise<void> {
    const regions = await this.platform.sessionManager.getSelectedRegions();
    this.selectedRegions = new Set(regions);
  }

  public isSelected(region: string): boolean {
    return this.selectedRegions.has(region);
  }

  public getTreeItem(element: RegionNode): vscode.TreeItem {
    if (element.kind === "regionGroup") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = "cloudView.regionGroup";
      item.iconPath = new vscode.ThemeIcon("globe");
      return item;
    }

    const item = new vscode.TreeItem(element.region, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "cloudView.region";
    item.iconPath = element.selected
      ? new vscode.ThemeIcon("map", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("map");

    // Fires the toggleRegion command when the region node is clicked.
    item.command = {
      command: "cloudView.toggleRegion",
      title: "Toggle Region",
      arguments: [element.region], // Passes the region name to the toggleRegion command.
    };
    return item;
  }

  public async getChildren(element?: RegionNode): Promise<RegionNode[]> {
    await this.loadSelected();

    if (!element) {
      return REGION_GROUPS.map((group) => ({
        kind: "regionGroup" as const,
        label: group.label,
        regions: group.regions,
      }));
    }

    if (element.kind === "regionGroup") {
      return element.regions.map((region) => ({
        kind: "region" as const,
        region,
        selected: this.selectedRegions.has(region),
      }));
    }

    return [];
  }
}

// ── 3) Profile Tree ──────────────────────────────────────────────────────────

export class ProfileTreeProvider implements vscode.TreeDataProvider<ProfileTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ProfileTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly platform: CloudViewPlatform) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: ProfileTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "cloudView.profile";
    item.iconPath = element.selected
      ? new vscode.ThemeIcon("account", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("account");
    item.description = element.selected ? "active" : undefined;
    item.command = {
      command: "cloudView.toggleProfile",
      title: "Toggle Profile",
      arguments: [element.name],
    };
    return item;
  }

  public async getChildren(): Promise<ProfileTreeNode[]> {
    const allProfiles = await this.platform.sessionManager.listProfiles();
    const selected = await this.platform.sessionManager.getSelectedProfiles();
    const selectedSet = new Set(selected);

    return allProfiles.map((profile) => ({
      kind: "profile" as const,
      name: profile.name,
      region: profile.region,
      selected: selectedSet.has(profile.name),
    }));
  }
}


/**
 * Holds the three registered {@link vscode.TreeDataProvider} instances (services,
 * regions, profiles). VS Code only wires those children to views; this class is
 * a convenience container and shared {@link refresh} entry point.
 */
export class CloudTreeViewProvider {
  public readonly serviceTree: ServiceTreeProvider;
  public readonly regionTree: RegionTreeProvider;
  public readonly profileTree: ProfileTreeProvider;

  public constructor(platform: CloudViewPlatform) {
    this.serviceTree = new ServiceTreeProvider(platform);
    this.regionTree = new RegionTreeProvider(platform);
    this.profileTree = new ProfileTreeProvider(platform);
  }

  public refresh(): void {
    this.serviceTree.refresh();
    this.regionTree.refresh();
    this.profileTree.refresh();
  }
}
