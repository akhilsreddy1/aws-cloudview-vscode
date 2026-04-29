import type { ResourceNode } from "../core/contracts";
import { ResourceTypes } from "../core/resourceTypes";

export interface ColumnDef {
  key: string;
  label: string;
  type: "text" | "status" | "code" | "number" | "bytes" | "date" | "bool";
  width?: string;
}

export interface StatDef {
  label: string;
  color: string;
  compute: (resources: ResourceNode[]) => string | number;
}

export interface TabDef {
  id: string;
  label: string;
  filter?: (resource: ResourceNode) => boolean;
  /** When set, only columns whose `key` is in this list are shown for this tab. */
  columns?: string[];
}

export interface ServiceViewConfig {
  serviceId: string;
  serviceLabel: string;
  iconKey: string;
  columns: ColumnDef[];
  stats: StatDef[];
  tabs?: TabDef[];
}

function rawVal(resource: ResourceNode, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = resource.rawJson;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function countByRawField(resources: ResourceNode[], path: string, value: string): number {
  return resources.filter((r) => String(rawVal(r, path) ?? "").toLowerCase() === value.toLowerCase()).length;
}

function sumRawField(resources: ResourceNode[], path: string): number {
  return resources.reduce((acc, r) => acc + (Number(rawVal(r, path)) || 0), 0);
}

// ─── Lambda ──────────────────────────────────────────────────────────────────

const lambdaConfig: ServiceViewConfig = {
  serviceId: "lambda",
  serviceLabel: "AWS Lambda",
  iconKey: "lambda",
  columns: [
    { key: "name", label: "Function Name", type: "text" },
    { key: "__lambdaInvoke", label: "Invoke", type: "text" },
    { key: "Runtime", label: "Runtime", type: "text" },
    { key: "Handler", label: "Handler", type: "code" },
    { key: "MemorySize", label: "Memory (MB)", type: "number" },
    { key: "Timeout", label: "Timeout (s)", type: "number" },
    { key: "CodeSizeMB", label: "Code (MB)", type: "number" },
    { key: "Architectures", label: "Arch", type: "text" },
    { key: "IsDeprecatedRuntime", label: "Deprecated", type: "bool" },
    { key: "LayerCount", label: "Layers", type: "number" },
    { key: "SnapStartEnabled", label: "SnapStart", type: "bool" },
    { key: "LastModified", label: "Last Modified", type: "date" },
  ],
  stats: [
    { label: "Total Functions", color: "#FF9900", compute: (r) => r.length },
    { label: "Deprecated Runtime", color: "#b91c1c", compute: (r) => r.filter((x) => rawVal(x, "IsDeprecatedRuntime") === true).length },
    { label: "SnapStart Enabled", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "SnapStartEnabled") === true).length },
    { label: "With Layers", color: "#854d0e", compute: (r) => r.filter((x) => rawVal(x, "HasLayers") === true).length },
    { label: "Node.js", color: "#339933", compute: (r) => r.filter((x) => String(rawVal(x, "Runtime") ?? "").startsWith("nodejs")).length },
    { label: "Python", color: "#3776AB", compute: (r) => r.filter((x) => String(rawVal(x, "Runtime") ?? "").startsWith("python")).length },
  ],
  tabs: [
    { id: "all", label: "All Functions" },
    { id: "deprecated_rt", label: "Deprecated Runtime", filter: (r) => rawVal(r, "IsDeprecatedRuntime") === true },
    { id: "nodejs", label: "Node.js", filter: (r) => String(rawVal(r, "Runtime") ?? "").startsWith("nodejs") },
    { id: "python", label: "Python", filter: (r) => String(rawVal(r, "Runtime") ?? "").startsWith("python") },
    { id: "java", label: "Java", filter: (r) => String(rawVal(r, "Runtime") ?? "").startsWith("java") },
    { id: "other_runtime", label: "Other", filter: (r) => { const rt = String(rawVal(r, "Runtime") ?? ""); return !rt.startsWith("nodejs") && !rt.startsWith("python") && !rt.startsWith("java"); } },
  ],
};

// ─── S3 ──────────────────────────────────────────────────────────────────────

const s3Config: ServiceViewConfig = {
  serviceId: "s3",
  serviceLabel: "Amazon S3",
  iconKey: "s3",
  columns: [
    { key: "name", label: "Bucket Name", type: "text" },
    { key: "__s3Browse", label: "Browse & Upload", type: "text" },
    { key: "BucketRegion", label: "Region", type: "text" },
    { key: "EncryptionType", label: "Encryption", type: "status" },
    { key: "VersioningStatus", label: "Versioning", type: "status" },
    { key: "PublicAccessBlocked", label: "Public Blocked", type: "bool" },
    { key: "CreationDate", label: "Created", type: "date" },
  ],
  stats: [
    { label: "Total Buckets", color: "#7AA116", compute: (r) => r.length },
    { label: "Unencrypted", color: "#b91c1c", compute: (r) => r.filter((x) => rawVal(x, "IsEncrypted") !== true).length },
    { label: "Versioning Enabled", color: "#15803d", compute: (r) => r.filter((x) => rawVal(x, "VersioningEnabled") === true).length },
    { label: "Public Access Possible", color: "#c2410c", compute: (r) => r.filter((x) => rawVal(x, "PublicAccessBlocked") !== true).length },
  ],
  tabs: [
    { id: "all", label: "All Buckets" },
    { id: "s3_unencrypted", label: "Unencrypted", filter: (r) => rawVal(r, "IsEncrypted") !== true },
    { id: "s3_no_versioning", label: "No Versioning", filter: (r) => rawVal(r, "VersioningEnabled") !== true },
    { id: "s3_public_possible", label: "Public Access Possible", filter: (r) => rawVal(r, "PublicAccessBlocked") !== true },
  ],
};

// ─── EC2 ─────────────────────────────────────────────────────────────────────

const ec2Config: ServiceViewConfig = {
  serviceId: "ec2",
  serviceLabel: "Amazon EC2",
  iconKey: "ec2",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Resource Type", type: "text" },
    { key: "id", label: "ID", type: "code" },
    { key: "__ec2StartStop", label: "Start / Stop", type: "text" },
    // EC2 Instance columns
    { key: "InstanceType", label: "Instance Type", type: "text" },
    { key: "State.Name", label: "State", type: "status" },
    { key: "AgeDays", label: "Age (days)", type: "number" },
    { key: "IsOldGeneration", label: "Old Gen", type: "bool" },
    { key: "EbsOptimized", label: "EBS Opt", type: "bool" },
    { key: "CpuCredits", label: "CPU Credits", type: "text" },
    { key: "PrivateIpAddress", label: "Private IP", type: "code" },
    { key: "PublicIpAddress", label: "Public IP", type: "code" },
    // Load Balancer columns
    { key: "Type", label: "LB Type", type: "text" },
    { key: "Scheme", label: "Scheme", type: "text" },
    { key: "State.Code", label: "LB State", type: "status" },
    { key: "DNSName", label: "DNS Name", type: "code" },
    { key: "IpAddressType", label: "IP Type", type: "text" },
    { key: "ListenerCount", label: "Listeners", type: "number" },
    { key: "ListenerSummary", label: "Listener Ports", type: "text" },
    { key: "AvailabilityZoneList", label: "AZs", type: "text" },
    // Target Group columns
    { key: "Protocol", label: "Protocol", type: "text" },
    { key: "Port", label: "Port", type: "number" },
    { key: "TargetType", label: "Target Type", type: "text" },
    { key: "TargetCount", label: "Targets", type: "number" },
    { key: "HealthyCount", label: "Healthy", type: "number" },
    { key: "UnhealthyCount", label: "Unhealthy", type: "number" },
    { key: "DrainingCount", label: "Draining", type: "number" },
    { key: "HealthCheckSummary", label: "Health Check", type: "text" },
    { key: "LoadBalancerNames", label: "Load Balancers", type: "text" },
    // Shared columns
    { key: "VpcId", label: "VPC", type: "code" },
    { key: "LaunchTime", label: "Launched", type: "date" },
    { key: "CreatedTime", label: "Created", type: "date" },
  ],
  stats: [
    { label: "EC2 Instances", color: "#FF9900", compute: (r) => r.filter((x) => x.type === "aws.ec2.instance").length },
    { label: "Running", color: "#15803d", compute: (r) => r.filter((x) => x.type === "aws.ec2.instance" && String(rawVal(x, "State.Name") ?? "").toLowerCase() === "running").length },
    { label: "Stopped", color: "#b91c1c", compute: (r) => r.filter((x) => x.type === "aws.ec2.instance" && String(rawVal(x, "State.Name") ?? "").toLowerCase() === "stopped").length },
    { label: "Old Generation", color: "#c2410c", compute: (r) => r.filter((x) => x.type === "aws.ec2.instance" && rawVal(x, "IsOldGeneration") === true).length },
    { label: "Load Balancers", color: "#8C4FFF", compute: (r) => r.filter((x) => x.type === "aws.elbv2.load-balancer").length },
    { label: "Target Groups", color: "#1d4ed8", compute: (r) => r.filter((x) => x.type === "aws.elbv2.target-group").length },
  ],
  tabs: [
    { id: "ec2_instances", label: "Instances", filter: (r) => r.type === "aws.ec2.instance",
      columns: ["name", "id", "__ec2StartStop", "InstanceType", "State.Name", "AgeDays", "IsOldGeneration", "EbsOptimized", "CpuCredits", "PrivateIpAddress", "PublicIpAddress", "VpcId", "LaunchTime"] },
    { id: "running", label: "Running", filter: (r) => r.type === "aws.ec2.instance" && String(rawVal(r, "State.Name") ?? "").toLowerCase() === "running",
      columns: ["name", "id", "__ec2StartStop", "InstanceType", "AgeDays", "IsOldGeneration", "EbsOptimized", "CpuCredits", "PrivateIpAddress", "PublicIpAddress", "VpcId", "LaunchTime"] },
    { id: "stopped", label: "Stopped", filter: (r) => r.type === "aws.ec2.instance" && String(rawVal(r, "State.Name") ?? "").toLowerCase() === "stopped",
      columns: ["name", "id", "__ec2StartStop", "InstanceType", "AgeDays", "IsOldGeneration", "PrivateIpAddress", "VpcId", "LaunchTime"] },
    { id: "ec2_old_gen", label: "Old Generation", filter: (r) => r.type === "aws.ec2.instance" && rawVal(r, "IsOldGeneration") === true,
      columns: ["name", "id", "__ec2StartStop", "InstanceType", "State.Name", "AgeDays", "CpuCredits", "VpcId", "LaunchTime"] },
    { id: "ec2_lbs", label: "Load Balancers", filter: (r) => r.type === "aws.elbv2.load-balancer",
      columns: ["name", "Type", "Scheme", "State.Code", "DNSName", "IpAddressType", "ListenerCount", "ListenerSummary", "AvailabilityZoneList", "VpcId", "CreatedTime"] },
    { id: "ec2_tgs", label: "Target Groups", filter: (r) => r.type === "aws.elbv2.target-group",
      columns: ["name", "Protocol", "Port", "TargetType", "TargetCount", "HealthyCount", "UnhealthyCount", "DrainingCount", "HealthCheckSummary", "LoadBalancerNames", "VpcId"] },
    ],
};

// ─── VPC ─────────────────────────────────────────────────────────────────────

const vpcConfig: ServiceViewConfig = {
  serviceId: "vpc",
  serviceLabel: "Amazon VPC",
  iconKey: "vpc",
  columns: [
    // Shared
    { key: "name", label: "Name", type: "text" },
    { key: "id", label: "Resource ID", type: "code" },
    { key: "type", label: "Type", type: "text" },
    // VPC / Subnet columns
    { key: "CidrBlock", label: "CIDR", type: "code" },
    { key: "State", label: "State", type: "status" },
    { key: "IsDefault", label: "Default", type: "bool" },
    { key: "AvailabilityZone", label: "AZ", type: "text" },
    { key: "AvailableIpAddressCount", label: "Free IPs", type: "number" },
    { key: "VpcId", label: "VPC", type: "code" },
    // Security Group columns
    { key: "GroupId", label: "Group ID", type: "code" },
    { key: "GroupName", label: "Group Name", type: "text" },
    { key: "Description", label: "Description", type: "text" },
    // VPC Endpoint columns
    { key: "ServiceName", label: "Endpoint service", type: "code" },
    { key: "VpcEndpointType", label: "Endpoint type", type: "text" },
    // Lattice columns
    { key: "status", label: "Lattice status", type: "status" },
    { key: "numberOfAssociatedVPCs", label: "Associated VPCs", type: "number" },
    { key: "numberOfAssociatedServices", label: "Associated Services", type: "number" },
  ],
  stats: [
    { label: "VPCs", color: "#8C4FFF", compute: (r) => r.filter((x) => x.type === "aws.ec2.vpc").length },
    { label: "Subnets", color: "#1d4ed8", compute: (r) => r.filter((x) => x.type === "aws.ec2.subnet").length },
    { label: "Endpoints", color: "#0d9488", compute: (r) => r.filter((x) => x.type === "aws.ec2.vpc-endpoint").length },
    { label: "Security Groups", color: "#c2410c", compute: (r) => r.filter((x) => x.type === "aws.ec2.security-group").length },
    { label: "Lattice networks", color: "#6d28d9", compute: (r) => r.filter((x) => x.type === "aws.vpc-lattice.service-network").length },
    { label: "Lattice services", color: "#9333ea", compute: (r) => r.filter((x) => x.type === "aws.vpc-lattice.service").length },
  ],
  tabs: [
    { id: "all", label: "All" },
    {
      id: "vpc_hierarchy",
      label: "VPC \u2192 subnets",
      filter: (r) => r.type === "aws.ec2.vpc" || r.type === "aws.ec2.subnet",
      columns: ["name", "id", "type", "CidrBlock", "State", "IsDefault", "AvailabilityZone", "AvailableIpAddressCount", "VpcId"],
    },
    {
      id: "vpcs",
      label: "VPCs",
      filter: (r) => r.type === "aws.ec2.vpc",
      columns: ["name", "id", "CidrBlock", "State", "IsDefault"],
    },
    {
      id: "subnets",
      label: "Subnets",
      filter: (r) => r.type === "aws.ec2.subnet",
      columns: ["name", "id", "CidrBlock", "State", "AvailabilityZone", "AvailableIpAddressCount", "VpcId"],
    },
    {
      id: "sgs",
      label: "Security Groups",
      filter: (r) => r.type === "aws.ec2.security-group",
      columns: ["name", "GroupId", "GroupName", "Description", "VpcId"],
    },
    {
      id: "vpc_endpoints",
      label: "Endpoints",
      filter: (r) => r.type === "aws.ec2.vpc-endpoint",
      columns: ["name", "id", "ServiceName", "VpcEndpointType", "State", "VpcId"],
    },
    {
      id: "lattice_networks",
      label: "Lattice networks",
      filter: (r) => r.type === "aws.vpc-lattice.service-network",
      columns: ["name", "id", "status", "numberOfAssociatedVPCs", "numberOfAssociatedServices"],
    },
    {
      id: "lattice_services",
      label: "Lattice services",
      filter: (r) => r.type === "aws.vpc-lattice.service",
      columns: ["name", "id", "status"],
    },
  ],
};

// ─── DynamoDB ────────────────────────────────────────────────────────────────

const dynamodbConfig: ServiceViewConfig = {
  serviceId: "dynamodb",
  serviceLabel: "Amazon DynamoDB",
  iconKey: "dynamodb",
  columns: [
    { key: "name", label: "Table Name", type: "text" },
    { key: "__dynamodbPeek", label: "Items", type: "text" },
    { key: "KeySchema", label: "Key Schema", type: "text" },
    { key: "ItemCount", label: "Item Count", type: "number" },
    { key: "TableSizeBytes", label: "Table Size", type: "bytes" },
    { key: "BillingModeSummary.BillingMode", label: "Billing Mode", type: "status" },
    { key: "CreationDateTime", label: "Created", type: "date" },
  ],
  stats: [
    { label: "Total Tables", color: "#4053D6", compute: (r) => r.length },
    { label: "On-Demand", color: "#6d28d9", compute: (r) => r.filter((x) => String(rawVal(x, "BillingModeSummary.BillingMode") ?? "").includes("PAY_PER_REQUEST")).length },
    { label: "Provisioned", color: "#1d4ed8", compute: (r) => r.filter((x) => { const bm = String(rawVal(x, "BillingModeSummary.BillingMode") ?? "PROVISIONED"); return bm.includes("PROVISIONED") || !bm.includes("PAY_PER_REQUEST"); }).length },
    { label: "Total Items", color: "#15803d", compute: (r) => sumRawField(r, "ItemCount") },
  ],
  tabs: [
    { id: "all", label: "All Tables" },
    { id: "on_demand", label: "On-Demand", filter: (r) => String(rawVal(r, "BillingModeSummary.BillingMode") ?? "").includes("PAY_PER_REQUEST") },
    { id: "provisioned", label: "Provisioned", filter: (r) => !String(rawVal(r, "BillingModeSummary.BillingMode") ?? "").includes("PAY_PER_REQUEST") },
  ],
};

// ─── EventBridge ─────────────────────────────────────────────────────────────

const eventbridgeConfig: ServiceViewConfig = {
  serviceId: "eventbridge",
  serviceLabel: "Amazon EventBridge",
  iconKey: "eventbridge",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "State", label: "State", type: "status" },
    { key: "EventBusName", label: "Event Bus", type: "text" },
    { key: "ScheduleExpression", label: "Schedule", type: "code" },
    { key: "Description", label: "Description", type: "text" },
  ],
  stats: [
    { label: "Event Buses", color: "#E7157B", compute: (r) => r.filter((x) => x.type === "aws.eventbridge.bus").length },
    { label: "Rules", color: "#1d4ed8", compute: (r) => r.filter((x) => x.type === "aws.eventbridge.rule").length },
    { label: "Enabled", color: "#15803d", compute: (r) => r.filter((x) => x.type === "aws.eventbridge.rule" && String(rawVal(x, "State") ?? "").toUpperCase() === "ENABLED").length },
    { label: "Disabled", color: "#b91c1c", compute: (r) => r.filter((x) => x.type === "aws.eventbridge.rule" && String(rawVal(x, "State") ?? "").toUpperCase() === "DISABLED").length },
  ],
  tabs: [
    { id: "all", label: "All" },
    { id: "buses", label: "Event Buses", filter: (r) => r.type === "aws.eventbridge.bus" },
    { id: "rules", label: "Rules", filter: (r) => r.type === "aws.eventbridge.rule" },
    { id: "enabled", label: "Enabled Rules", filter: (r) => r.type === "aws.eventbridge.rule" && String(rawVal(r, "State") ?? "").toUpperCase() === "ENABLED" },
    { id: "disabled", label: "Disabled Rules", filter: (r) => r.type === "aws.eventbridge.rule" && String(rawVal(r, "State") ?? "").toUpperCase() === "DISABLED" },
  ],
};

// ─── ECR ─────────────────────────────────────────────────────────────────────

const ecrConfig: ServiceViewConfig = {
  serviceId: "ecr",
  serviceLabel: "Amazon ECR",
  iconKey: "ecr",
  columns: [
    { key: "name", label: "Repository Name", type: "text" },
    { key: "__ecrImages", label: "Images", type: "text" },
    { key: "repositoryUri", label: "URI", type: "code" },
    { key: "imageScanningConfiguration.scanOnPush", label: "Scan on Push", type: "bool" },
    { key: "imageTagMutability", label: "Tag Mutability", type: "status" },
    { key: "encryptionConfiguration.encryptionType", label: "Encryption", type: "text" },
    { key: "createdAt", label: "Created", type: "date" },
  ],
  stats: [
    { label: "Total Repos", color: "#FF9900", compute: (r) => r.length },
    { label: "Scan on Push", color: "#15803d", compute: (r) => r.filter((x) => rawVal(x, "imageScanningConfiguration.scanOnPush") === true).length },
    { label: "Mutable Tags", color: "#854d0e", compute: (r) => r.filter((x) => String(rawVal(x, "imageTagMutability") ?? "").toUpperCase() === "MUTABLE").length },
    { label: "Immutable Tags", color: "#1d4ed8", compute: (r) => r.filter((x) => String(rawVal(x, "imageTagMutability") ?? "").toUpperCase() === "IMMUTABLE").length },
  ],
  tabs: [
    { id: "all", label: "All Repositories" },
    { id: "scan_enabled", label: "Scan on Push", filter: (r) => rawVal(r, "imageScanningConfiguration.scanOnPush") === true },
    { id: "mutable", label: "Mutable", filter: (r) => String(rawVal(r, "imageTagMutability") ?? "").toUpperCase() === "MUTABLE" },
    { id: "immutable", label: "Immutable", filter: (r) => String(rawVal(r, "imageTagMutability") ?? "").toUpperCase() === "IMMUTABLE" },
  ],
};

// ─── Redshift ────────────────────────────────────────────────────────────────

const redshiftConfig: ServiceViewConfig = {
  serviceId: "redshift",
  serviceLabel: "Amazon Redshift",
  iconKey: "redshift",
  columns: [
    { key: "name", label: "Cluster ID", type: "text" },
    { key: "NodeType", label: "Node Type", type: "text" },
    { key: "ClusterStatus", label: "Status", type: "status" },
    { key: "DBName", label: "DB Name", type: "text" },
    { key: "NumberOfNodes", label: "Nodes", type: "number" },
    { key: "MasterUsername", label: "Master User", type: "text" },
    { key: "VpcId", label: "VPC", type: "code" },
    { key: "Encrypted", label: "Encrypted", type: "bool" },
    { key: "ClusterVersion", label: "Version", type: "text" },
  ],
  stats: [
    { label: "Total Clusters", color: "#8C4FFF", compute: (r) => r.length },
    { label: "Available", color: "#15803d", compute: (r) => countByRawField(r, "ClusterStatus", "available") },
    { label: "Total Nodes", color: "#1d4ed8", compute: (r) => sumRawField(r, "NumberOfNodes") },
    { label: "Encrypted", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "Encrypted") === true).length },
  ],
};

// ─── RDS ─────────────────────────────────────────────────────────────────────

const rdsConfig: ServiceViewConfig = {
  serviceId: "rds",
  serviceLabel: "Databases",
  iconKey: "rds",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "__rdsStartStop", label: "Start / Stop", type: "text" },
    { key: "DBClusterIdentifier", label: "DB Cluster", type: "code" },
    { key: "Engine", label: "Engine", type: "text" },
    { key: "EngineVersion", label: "Version", type: "text" },
    { key: "DBInstanceClass", label: "Class", type: "text" },
    { key: "DBInstanceStatus", label: "Status", type: "status" },
    { key: "SnapshotType", label: "Snapshot Type", type: "status" },
    { key: "Endpoint.Address", label: "Endpoint", type: "code" },
    { key: "ReaderEndpoint", label: "Reader endpoint", type: "code" },
    { key: "MultiAZ", label: "Multi-AZ", type: "bool" },
    { key: "StorageEncrypted", label: "Encrypted", type: "bool" },
    { key: "PubliclyAccessible", label: "Public", type: "bool" },
    { key: "HasPendingMaintenance", label: "Pending Maint.", type: "bool" },
    { key: "CACertificateIdentifier", label: "CA Cert", type: "text" },
    { key: "IsOldCACert", label: "Old CA Cert", type: "bool" },
    { key: "AllocatedStorage", label: "Storage (GB)", type: "number" },
    { key: "SnapshotCreateTime", label: "Snapshot Created", type: "date" },
  ],
  stats: [
    { label: "DB Clusters", color: "#527FFF", compute: (r) => r.filter((x) => x.type === "aws.rds.cluster").length },
    { label: "DB Instances", color: "#FF9900", compute: (r) => r.filter((x) => x.type === "aws.rds.instance").length },
    { label: "Publicly Accessible", color: "#b91c1c", compute: (r) => r.filter((x) => x.type === "aws.rds.instance" && rawVal(x, "PubliclyAccessible") === true).length },
    { label: "Pending Maintenance", color: "#c2410c", compute: (r) => r.filter((x) => x.type === "aws.rds.instance" && rawVal(x, "HasPendingMaintenance") === true).length },
    { label: "Old CA Cert", color: "#854d0e", compute: (r) => r.filter((x) => x.type === "aws.rds.instance" && rawVal(x, "IsOldCACert") === true).length },
    { label: "Backups + Snapshots", color: "#6b7280", compute: (r) => r.filter((x) => x.type === "aws.rds.snapshot" || x.type === "aws.rds.cluster-snapshot").length },
  ],
  tabs: [
    { id: "all", label: "All" },
    {
      id: "rds_hierarchy",
      label: "Cluster → Instances",
      filter: (r) => r.type === "aws.rds.cluster" || r.type === "aws.rds.instance",
    },
    { id: "rds_public", label: "Publicly Accessible", filter: (r) => r.type === "aws.rds.instance" && rawVal(r, "PubliclyAccessible") === true },
    { id: "rds_pending", label: "Pending Maintenance", filter: (r) => r.type === "aws.rds.instance" && rawVal(r, "HasPendingMaintenance") === true },
    { id: "rds_snapshots", label: "Snapshots", filter: (r) => r.type === "aws.rds.snapshot" },
    { id: "rds_cluster_snapshots", label: "Cluster Snapshots", filter: (r) => r.type === "aws.rds.cluster-snapshot" },
    { id: "rds_automated", label: "Automated Backups", filter: (r) => r.type === "aws.rds.snapshot" && String(rawVal(r, "SnapshotType") ?? "").toLowerCase() === "automated" },
  ],
};

// ─── ECS ─────────────────────────────────────────────────────────────────────

/** Shared by Tasks / Healthy / Unhealthy tabs (task-level + container fields). */
const ecsTaskTabColumnKeys: string[] = [
  "name",
  "id",
  "type",
  "status",
  "ContainerName",
  "ContainerImage",
  "ContainerStatus",
  "HealthStatus",
  "Cpu",
  "Memory",
  "TaskDefinitionShort",
  "ContainerCount",
  "launchType",
];

const ecsConfig: ServiceViewConfig = {
  serviceId: "ecs",
  serviceLabel: "Amazon ECS",
  iconKey: "ecs",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "__ecsScale", label: "Scale", type: "text" },
    { key: "id", label: "ID", type: "code" },
    { key: "type", label: "Type", type: "text" },
    { key: "status", label: "Status", type: "status" },
    // Clusters
    { key: "runningTasksCount", label: "Running Tasks", type: "number" },
    { key: "activeServicesCount", label: "Active Services", type: "number" },
    // Services
    { key: "desiredCount", label: "Desired", type: "number" },
    { key: "runningCount", label: "Running", type: "number" },
    { key: "launchType", label: "Launch Type", type: "text" },
    // Tasks
    { key: "ContainerName", label: "Container", type: "text" },
    { key: "ContainerImage", label: "Image", type: "code" },
    { key: "ContainerStatus", label: "Container Status", type: "status" },
    { key: "HealthStatus", label: "Health", type: "status" },
    { key: "Cpu", label: "CPU", type: "text" },
    { key: "Memory", label: "Memory", type: "text" },
    { key: "TaskDefinitionShort", label: "Task Def", type: "code" },
    { key: "ContainerCount", label: "Containers", type: "number" },
  ],
  stats: [
    { label: "Total Resources", color: "#FF9900", compute: (r) => r.length },
    { label: "Clusters", color: "#1d4ed8", compute: (r) => r.filter((x) => x.type === "aws.ecs.cluster").length },
    { label: "Services", color: "#6d28d9", compute: (r) => r.filter((x) => x.type === "aws.ecs.service").length },
    { label: "Tasks", color: "#15803d", compute: (r) => r.filter((x) => x.type === "aws.ecs.task").length },
    { label: "Healthy", color: "#059669", compute: (r) => r.filter((x) => x.type === "aws.ecs.task" && rawVal(x, "HealthStatus") === "HEALTHY").length },
    { label: "Unhealthy", color: "#b91c1c", compute: (r) => r.filter((x) => x.type === "aws.ecs.task" && rawVal(x, "HealthStatus") === "UNHEALTHY").length },
  ],
  tabs: [
    {
      id: "all",
      label: "All",
      columns: [
        "name",
        "__ecsScale",
        "id",
        "type",
        "status",
        "runningTasksCount",
        "activeServicesCount",
        "desiredCount",
        "runningCount",
        "launchType",
        "TaskDefinitionShort",
        "HealthStatus",
        "ContainerStatus",
      ],
    },
    {
      id: "ecs_clusters",
      label: "Clusters",
      filter: (r) => r.type === "aws.ecs.cluster",
      columns: ["name", "id", "type", "status", "runningTasksCount", "activeServicesCount"],
    },
    {
      id: "ecs_services",
      label: "Services",
      filter: (r) => r.type === "aws.ecs.service",
      columns: ["name", "__ecsScale", "id", "type", "status", "desiredCount", "runningCount", "launchType"],
    },
    {
      id: "ecs_tasks",
      label: "Tasks",
      filter: (r) => r.type === "aws.ecs.task",
      columns: [...ecsTaskTabColumnKeys],
    },
    {
      id: "ecs_healthy",
      label: "Healthy",
      filter: (r) => r.type === "aws.ecs.task" && rawVal(r, "HealthStatus") === "HEALTHY",
      columns: [...ecsTaskTabColumnKeys],
    },
    {
      id: "ecs_unhealthy",
      label: "Unhealthy",
      filter: (r) => r.type === "aws.ecs.task" && rawVal(r, "HealthStatus") === "UNHEALTHY",
      columns: [...ecsTaskTabColumnKeys],
    },
  ],
};

// ─── MSK ─────────────────────────────────────────────────────────────────────

const mskConfig: ServiceViewConfig = {
  serviceId: "msk",
  serviceLabel: "Amazon MSK",
  iconKey: "msk",
  columns: [
    { key: "name", label: "Cluster Name", type: "text" },
    { key: "__mskTopics", label: "Topics", type: "text" },
    { key: "State", label: "State", type: "status" },
    { key: "ClusterType", label: "Type", type: "text" },
    { key: "KafkaVersion", label: "Kafka Version", type: "text" },
    { key: "NumberOfBrokerNodes", label: "Brokers", type: "number" },
    { key: "BrokerInstanceType", label: "Instance Type", type: "text" },
    { key: "StoragePerBrokerGB", label: "Storage/Broker (GB)", type: "number" },
    { key: "EnhancedMonitoring", label: "Monitoring", type: "text" },
    { key: "id", label: "Cluster ID", type: "code" },
  ],
  stats: [
    { label: "Total Clusters", color: "#C7131F", compute: (r) => r.length },
    { label: "Active", color: "#15803d", compute: (r) => countByRawField(r, "State", "ACTIVE") },
    { label: "Total Broker Nodes", color: "#1d4ed8", compute: (r) => sumRawField(r, "NumberOfBrokerNodes") },
    { label: "Serverless", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "IsServerless") === true).length },
  ],
  tabs: [
    { id: "all", label: "All Clusters" },
    { id: "msk_active", label: "Active", filter: (r) => String(rawVal(r, "State") ?? "").toUpperCase() === "ACTIVE" },
    { id: "msk_provisioned", label: "Provisioned", filter: (r) => String(rawVal(r, "ClusterType") ?? "").toUpperCase() === "PROVISIONED" },
    { id: "msk_serverless", label: "Serverless", filter: (r) => rawVal(r, "IsServerless") === true || String(rawVal(r, "ClusterType") ?? "").toUpperCase() === "SERVERLESS" },
  ],
};

// ─── CloudFormation ──────────────────────────────────────────────────────────

const cloudformationConfig: ServiceViewConfig = {
  serviceId: "cloudformation",
  serviceLabel: "AWS CloudFormation",
  iconKey: "cloudformation",
  columns: [
    { key: "name", label: "Stack Name", type: "text" },
    { key: "__cfnTemplate", label: "Template", type: "text" },
    { key: "StackStatus", label: "Status", type: "status" },
    { key: "Description", label: "Description", type: "text" },
    { key: "CreationTime", label: "Created", type: "date" },
    { key: "LastUpdatedTime", label: "Last Updated", type: "date" },
    { key: "__cfnDelete", label: "Actions", type: "text" },
    { key: "AgeDays", label: "Age (days)", type: "number" },
    { key: "DriftStatus", label: "Drift", type: "status" },
    { key: "EnableTerminationProtection", label: "Term. Protection", type: "bool" },
    { key: "IsNestedStack", label: "Nested", type: "bool" },
    { key: "OutputCount", label: "Outputs", type: "number" },
    { key: "ParameterCount", label: "Parameters", type: "number" },
    { key: "Capabilities", label: "Capabilities", type: "text" },
    { key: "RoleARN", label: "Role ARN", type: "code" },
  ],
  stats: [
    { label: "Total Stacks", color: "#1d4ed8", compute: (r) => r.length },
    { label: "Active", color: "#15803d", compute: (r) => r.filter((x) => String(rawVal(x, "StackStatus") ?? "").endsWith("_COMPLETE") && !String(rawVal(x, "StackStatus") ?? "").includes("DELETE") && !String(rawVal(x, "StackStatus") ?? "").includes("ROLLBACK")).length },
    { label: "In Progress", color: "#854d0e", compute: (r) => r.filter((x) => String(rawVal(x, "StackStatus") ?? "").includes("IN_PROGRESS")).length },
    { label: "Failed / Rollback", color: "#b91c1c", compute: (r) => r.filter((x) => { const s = String(rawVal(x, "StackStatus") ?? ""); return s.includes("FAILED") || s.includes("ROLLBACK"); }).length },
    { label: "Drift Detected", color: "#E7157B", compute: (r) => r.filter((x) => rawVal(x, "IsDriftDetected") === true).length },
    { label: "Nested", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "IsNestedStack") === true).length },
  ],
  tabs: [
    { id: "all", label: "All Stacks" },
    { id: "cfn_active", label: "Active", filter: (r) => { const s = String(rawVal(r, "StackStatus") ?? ""); return s.endsWith("_COMPLETE") && !s.includes("DELETE") && !s.includes("ROLLBACK"); } },
    { id: "cfn_in_progress", label: "In Progress", filter: (r) => String(rawVal(r, "StackStatus") ?? "").includes("IN_PROGRESS") },
    { id: "cfn_failed", label: "Failed / Rollback", filter: (r) => { const s = String(rawVal(r, "StackStatus") ?? ""); return s.includes("FAILED") || s.includes("ROLLBACK"); } },
    { id: "cfn_drifted", label: "Drifted", filter: (r) => rawVal(r, "IsDriftDetected") === true },
    { id: "cfn_nested", label: "Nested", filter: (r) => rawVal(r, "IsNestedStack") === true },
    { id: "cfn_protected", label: "Protected", filter: (r) => rawVal(r, "EnableTerminationProtection") === true },
  ],
};

// ─── Step Functions ──────────────────────────────────────────────────────────

const stepfunctionsConfig: ServiceViewConfig = {
  serviceId: "stepfunctions",
  serviceLabel: "AWS Step Functions",
  iconKey: "stepfunctions",
  columns: [
    { key: "name", label: "State Machine", type: "text" },
    { key: "__sfnExecute", label: "Execute", type: "text" },
    { key: "StateMachineType", label: "Type", type: "status" },
    { key: "Status", label: "Status", type: "status" },
    { key: "StateCount", label: "States", type: "number" },
    { key: "LoggingEnabled", label: "Logging", type: "bool" },
    { key: "RoleArn", label: "Role", type: "code" },
    { key: "CreationDate", label: "Created", type: "date" },
  ],
  stats: [
    { label: "Total State Machines", color: "#C925D1", compute: (r) => r.length },
    { label: "Standard", color: "#1d4ed8", compute: (r) => countByRawField(r, "StateMachineType", "STANDARD") },
    { label: "Express", color: "#FF9900", compute: (r) => countByRawField(r, "StateMachineType", "EXPRESS") },
    { label: "Logging Enabled", color: "#15803d", compute: (r) => r.filter((x) => rawVal(x, "LoggingEnabled") === true).length },
    { label: "X-Ray Enabled", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "TracingEnabled") === true).length },
    { label: "Total States", color: "#0369a1", compute: (r) => sumRawField(r, "StateCount") },
  ],
  tabs: [
    { id: "all", label: "All State Machines" },
    { id: "sfn_standard", label: "Standard", filter: (r) => String(rawVal(r, "StateMachineType") ?? "").toUpperCase() === "STANDARD" },
    { id: "sfn_express", label: "Express", filter: (r) => String(rawVal(r, "StateMachineType") ?? "").toUpperCase() === "EXPRESS" },
  ],
};

// ─── CloudWatch Logs ─────────────────────────────────────────────────────────

const logsConfig: ServiceViewConfig = {
  serviceId: "logs",
  serviceLabel: "CloudWatch Logs",
  iconKey: "logs",
  columns: [
    { key: "name", label: "Log Group", type: "text" },
    { key: "__logsBrowse", label: "Streams", type: "text" },
    { key: "Source", label: "Source", type: "status" },
    { key: "RetentionInDays", label: "Retention (days)", type: "number" },
    { key: "StoredBytes", label: "Stored", type: "bytes" },
    { key: "LogClass", label: "Class", type: "status" },
    { key: "IsEncrypted", label: "KMS", type: "bool" },
    { key: "CreationTime", label: "Created", type: "date" },
  ],
  stats: [
    { label: "Log Groups", color: "#E7157B", compute: (r) => r.length },
    { label: "Never Expire", color: "#b91c1c", compute: (r) => r.filter((x) => rawVal(x, "HasRetention") !== true).length },
    { label: "Total Stored", color: "#1d4ed8", compute: (r) => {
      const bytes = sumRawField(r, "StoredBytes");
      if (bytes === 0) { return "0 B"; }
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    } },
    { label: "Encrypted (KMS)", color: "#6d28d9", compute: (r) => r.filter((x) => rawVal(x, "IsEncrypted") === true).length },
    { label: "Lambda Groups", color: "#FF9900", compute: (r) => r.filter((x) => rawVal(x, "Source") === "Lambda").length },
    { label: "ECS Groups", color: "#c2410c", compute: (r) => r.filter((x) => rawVal(x, "Source") === "ECS").length },
  ],
  tabs: [
    { id: "all", label: "All Log Groups" },
    { id: "logs_no_retention", label: "Never Expire", filter: (r) => rawVal(r, "HasRetention") !== true },
  ],
};

// ─── SQS ─────────────────────────────────────────────────────────────────────

const sqsConfig: ServiceViewConfig = {
  serviceId: "sqs",
  serviceLabel: "Amazon SQS",
  iconKey: "sqs",
  columns: [
    { key: "name", label: "Queue Name", type: "text" },
    { key: "__sqsViewMessages", label: "Messages", type: "text" },
    { key: "IsFifo", label: "FIFO", type: "bool" },
    { key: "VisibleMessages", label: "Visible", type: "number" },
    { key: "InFlightMessages", label: "In-flight", type: "number" },
    { key: "DelayedMessages", label: "Delayed", type: "number" },
    { key: "TotalMessages", label: "Total", type: "number" },
    { key: "LooksLikeDlq", label: "DLQ (by name)", type: "bool" },
    { key: "DlqTargetArn", label: "Redrives to", type: "code" },
  ],
  stats: [
    { label: "Total Queues", color: "#E7157B", compute: (r) => r.length },
    { label: "FIFO", color: "#1d4ed8", compute: (r) => r.filter((x) => rawVal(x, "IsFifo") === true).length },
    { label: "DLQ (by name)", color: "#b91c1c", compute: (r) => r.filter((x) => rawVal(x, "LooksLikeDlq") === true).length },
    { label: "With DLQ target", color: "#854d0e", compute: (r) => r.filter((x) => Boolean(rawVal(x, "DlqTargetArn"))).length },
    { label: "Visible messages", color: "#15803d", compute: (r) => sumRawField(r, "VisibleMessages") },
    { label: "In-flight messages", color: "#c2410c", compute: (r) => sumRawField(r, "InFlightMessages") },
  ],
  tabs: [
    { id: "all", label: "All Queues" },
    { id: "sqs_fifo", label: "FIFO", filter: (r) => rawVal(r, "IsFifo") === true },
    { id: "sqs_standard", label: "Standard", filter: (r) => rawVal(r, "IsFifo") !== true },
    { id: "sqs_dlq", label: "DLQs", filter: (r) => rawVal(r, "LooksLikeDlq") === true },
    { id: "sqs_has_messages", label: "Has messages", filter: (r) => Number(rawVal(r, "TotalMessages") ?? 0) > 0 },
  ],
};

// ─── Export ──────────────────────────────────────────────────────────────────

export const SERVICE_VIEW_CONFIGS: Record<string, ServiceViewConfig> = {
  lambda: lambdaConfig,
  s3: s3Config,
  ec2: ec2Config,
  vpc: vpcConfig,
  dynamodb: dynamodbConfig,
  eventbridge: eventbridgeConfig,
  ecr: ecrConfig,
  redshift: redshiftConfig,
  rds: rdsConfig,
  ecs: ecsConfig,
  msk: mskConfig,
  cloudformation: cloudformationConfig,
  stepfunctions: stepfunctionsConfig,
  logs: logsConfig,
  sqs: sqsConfig,
};

export function getServiceViewConfig(serviceId: string): ServiceViewConfig | undefined {
  return SERVICE_VIEW_CONFIGS[serviceId];
}

export function resolveResourceValue(resource: ResourceNode, key: string): unknown {
  if (
    key === "__ecsScale" ||
    key === "__dynamodbPeek" ||
    key === "__cfnTemplate" ||
    key === "__ec2StartStop" ||
    key === "__rdsStartStop"
  ) {
    return "";
  }
  if (key === "name") return resource.name || resource.id || "";
  if (key === "id") return resource.id;
  if (key === "type") return resource.type.split(".").pop() ?? resource.type;
  if (key === "arn") return resource.arn;
  if (key === "region") return resource.region;
  if (key === "accountId") return resource.accountId;
  if (key === "status") {
    return rawVal(resource, "status") ?? rawVal(resource, "State") ?? rawVal(resource, "State.Name");
  }

  // DynamoDB KeySchema: array of { AttributeName, KeyType: "HASH" | "RANGE" }.
  // Render as e.g. "userId (HASH), createdAt (RANGE)".
  if (key === "KeySchema") {
    const schema = rawVal(resource, "KeySchema");
    if (Array.isArray(schema) && schema.length > 0) {
      return schema
        .map((s) => {
          const obj = s as { AttributeName?: unknown; KeyType?: unknown };
          const attr = obj && typeof obj.AttributeName === "string" ? obj.AttributeName : "";
          const kt = obj && typeof obj.KeyType === "string" ? obj.KeyType : "";
          return attr ? (kt ? `${attr} (${kt})` : attr) : "";
        })
        .filter((s) => s.length > 0)
        .join(", ");
    }
    return undefined;
  }

  // Aurora / DescribeDBClusters: writer endpoint is a string on `Endpoint`, not `Endpoint.Address`.
  if (key === "Endpoint.Address" && resource.type === ResourceTypes.rdsCluster) {
    const ep = rawVal(resource, "Endpoint");
    const port = rawVal(resource, "Port");
    if (typeof ep === "string" && ep.length > 0) {
      if (port !== undefined && port !== null && String(port) !== "") {
        return `${ep}:${String(port)}`;
      }
      return ep;
    }
    return undefined;
  }

  const parts = key.split(".");
  let current: unknown = resource.rawJson;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
