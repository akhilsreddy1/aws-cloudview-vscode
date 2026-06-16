import {
  GetJobsCommand,
  GetJobRunsCommand,
  GetCrawlersCommand,
  ListWorkflowsCommand,
  BatchGetWorkflowsCommand,
  GetTriggersCommand,
  type Job,
  type JobRun,
  type Crawler,
  type Workflow,
  type Trigger,
} from "@aws-sdk/client-glue";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import {
  buildGlueJobArn,
  buildGlueCrawlerArn,
  buildGlueWorkflowArn,
  buildGlueTriggerArn,
} from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

/**
 * Discovers Glue ETL jobs. For each job we also fetch its most-recent run so
 * the dashboard can show the last-run status + timing without the user having
 * to open the runs panel. The latest-run fetch is best-effort and capped to
 * one record per job to keep the discovery cost bounded.
 */
/**
 * How many jobs' last-run lookups to issue concurrently. Each job triggers
 * one `GetJobRuns` call; per-region rate limits are still enforced by the
 * platform scheduler, so this cap just controls orchestration parallelism.
 */
const JOB_CONCURRENCY = 8;

const glueJobDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.glue(scope);
    const resources: ResourceNode[] = [];

    const jobs: Job[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("glue", "GetJobs", () =>
        client.send(new GetJobsCommand({ NextToken: nextToken, MaxResults: 100 }))
      );
      for (const job of resp.Jobs ?? []) jobs.push(job);
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "glue:GetJobs",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    const namedJobs = jobs.filter((j): j is Job & { Name: string } => typeof j.Name === "string" && j.Name.length > 0);

    /**
     * Build one job's resource node, including its most-recent run for the
     * last-status column. The `GetJobRuns` call is best-effort — a permission
     * denial or throttle on one job's runs shouldn't break discovery.
     */
    const processJob = async (job: Job & { Name: string }): Promise<ResourceNode> => {
      let lastRun: JobRun | undefined;
      try {
        const runResp = await platform.scheduler.run("glue", "GetJobRuns", () =>
          client.send(new GetJobRunsCommand({ JobName: job.Name, MaxResults: 1 }))
        );
        lastRun = runResp.JobRuns?.[0];
      } catch {
        // permission / throttle on one job's runs shouldn't break discovery
      }

      const command = job.Command ?? {};
      const arn = buildGlueJobArn(scope.region, scope.accountId, job.Name);
      return {
        arn,
        id: job.Name,
        type: ResourceTypes.glueJob,
        service: "glue",
        accountId: scope.accountId,
        region: scope.region,
        name: job.Name,
        tags: {},
        rawJson: {
          JobName: job.Name,
          Role: job.Role,
          GlueVersion: job.GlueVersion,
          // Command.Name is `glueetl` (Spark), `pythonshell`, `gluestreaming`, `glueray`.
          JobType: command.Name,
          ScriptLocation: command.ScriptLocation,
          PythonVersion: command.PythonVersion,
          WorkerType: job.WorkerType,
          NumberOfWorkers: job.NumberOfWorkers,
          MaxCapacity: job.MaxCapacity,
          Timeout: job.Timeout,
          MaxRetries: job.MaxRetries,
          CreatedOn: job.CreatedOn ? job.CreatedOn.toISOString() : undefined,
          LastModifiedOn: job.LastModifiedOn ? job.LastModifiedOn.toISOString() : undefined,
          // Last-run summary (denormalised for the dashboard).
          LastRunState: lastRun?.JobRunState,
          LastRunId: lastRun?.Id,
          LastRunStarted: lastRun?.StartedOn ? lastRun.StartedOn.toISOString() : undefined,
          LastRunDurationSec: lastRun?.ExecutionTime,
          // The default CloudWatch log group Glue writes job-run logs to.
          // Per-run streams are keyed by the JobRunId.
          OutputLogGroup: "/aws-glue/jobs/output",
          ErrorLogGroup: "/aws-glue/jobs/error",
        },
        lastUpdated: Date.now(),
      };
    };

    // Process jobs in concurrent batches. Output order matches input order
    // (batches are sequential, within a batch we await Promise.all).
    for (let i = 0; i < namedJobs.length; i += JOB_CONCURRENCY) {
      if (context.cancellation?.isCancellationRequested) break;
      const batch = namedJobs.slice(i, i + JOB_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(processJob));
      for (const r of batchResults) resources.push(r);
    }

    return resources;
  },
};

// ─── Glue Crawlers ───────────────────────────────────────────────────────────

/**
 * Summarises a crawler's targets (S3 paths, JDBC connections, DynamoDB tables,
 * etc.) into a one-line label for the dashboard.
 */
function summariseCrawlerTargets(crawler: Crawler): string {
  const t = crawler.Targets;
  if (!t) return "";
  const bits: string[] = [];
  if (t.S3Targets?.length) bits.push(`${t.S3Targets.length} S3`);
  if (t.JdbcTargets?.length) bits.push(`${t.JdbcTargets.length} JDBC`);
  if (t.DynamoDBTargets?.length) bits.push(`${t.DynamoDBTargets.length} DynamoDB`);
  if (t.CatalogTargets?.length) bits.push(`${t.CatalogTargets.length} catalog`);
  if (t.MongoDBTargets?.length) bits.push(`${t.MongoDBTargets.length} MongoDB`);
  if (t.DeltaTargets?.length) bits.push(`${t.DeltaTargets.length} Delta`);
  if (t.IcebergTargets?.length) bits.push(`${t.IcebergTargets.length} Iceberg`);
  if (t.HudiTargets?.length) bits.push(`${t.HudiTargets.length} Hudi`);
  return bits.join(", ");
}

const glueCrawlerDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.glue(scope);
    const resources: ResourceNode[] = [];

    const crawlers: Crawler[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("glue", "GetCrawlers", () =>
        client.send(new GetCrawlersCommand({ NextToken: nextToken, MaxResults: 100 }))
      );
      for (const c of resp.Crawlers ?? []) crawlers.push(c);
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "glue:GetCrawlers",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    for (const crawler of crawlers) {
      if (!crawler.Name) continue;
      const arn = buildGlueCrawlerArn(scope.region, scope.accountId, crawler.Name);
      resources.push({
        arn,
        id: crawler.Name,
        type: ResourceTypes.glueCrawler,
        service: "glue",
        accountId: scope.accountId,
        region: scope.region,
        name: crawler.Name,
        tags: {},
        rawJson: {
          CrawlerName: crawler.Name,
          State: crawler.State,
          Role: crawler.Role,
          DatabaseName: crawler.DatabaseName,
          TablePrefix: crawler.TablePrefix,
          TargetSummary: summariseCrawlerTargets(crawler),
          Schedule: crawler.Schedule?.ScheduleExpression,
          ScheduleState: crawler.Schedule?.State,
          // Last-crawl summary (denormalised for the dashboard).
          LastCrawlStatus: crawler.LastCrawl?.Status,
          LastCrawlStarted: crawler.LastCrawl?.StartTime ? crawler.LastCrawl.StartTime.toISOString() : undefined,
          LastCrawlMessage: crawler.LastCrawl?.MessagePrefix,
          CrawlElapsedMs: crawler.CrawlElapsedTime,
          Version: crawler.Version,
          CreationTime: crawler.CreationTime ? crawler.CreationTime.toISOString() : undefined,
          LastUpdated: crawler.LastUpdated ? crawler.LastUpdated.toISOString() : undefined,
          RecrawlPolicy: crawler.RecrawlPolicy?.RecrawlBehavior,
        },
        lastUpdated: Date.now(),
      });
    }
    return resources;
  },
};

// ─── Glue Workflows ──────────────────────────────────────────────────────────

const glueWorkflowDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.glue(scope);
    const resources: ResourceNode[] = [];

    // 1. List workflow names (paginated).
    const names: string[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("glue", "ListWorkflows", () =>
        client.send(new ListWorkflowsCommand({ NextToken: nextToken, MaxResults: 25 }))
      );
      for (const n of resp.Workflows ?? []) names.push(n);
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "glue:ListWorkflows",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    // 2. BatchGetWorkflows for details. Caps at 25 names per call.
    const details: Workflow[] = [];
    for (let i = 0; i < names.length; i += 25) {
      if (context.cancellation?.isCancellationRequested) break;
      const chunk = names.slice(i, i + 25);
      try {
        const resp = await platform.scheduler.run("glue", "BatchGetWorkflows", () =>
          client.send(new BatchGetWorkflowsCommand({ Names: chunk, IncludeGraph: false }))
        );
        for (const w of resp.Workflows ?? []) details.push(w);
      } catch (err) {
        platform.logger.warn(`BatchGetWorkflows failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const wf of details) {
      if (!wf.Name) continue;
      const arn = buildGlueWorkflowArn(scope.region, scope.accountId, wf.Name);
      resources.push({
        arn,
        id: wf.Name,
        type: ResourceTypes.glueWorkflow,
        service: "glue",
        accountId: scope.accountId,
        region: scope.region,
        name: wf.Name,
        tags: {},
        rawJson: {
          WorkflowName: wf.Name,
          Description: wf.Description,
          MaxConcurrentRuns: wf.MaxConcurrentRuns,
          CreatedOn: wf.CreatedOn ? wf.CreatedOn.toISOString() : undefined,
          LastModifiedOn: wf.LastModifiedOn ? wf.LastModifiedOn.toISOString() : undefined,
          // Last-run summary (denormalised for the dashboard).
          LastRunStatus: wf.LastRun?.Status,
          LastRunId: wf.LastRun?.WorkflowRunId,
          LastRunStarted: wf.LastRun?.StartedOn ? wf.LastRun.StartedOn.toISOString() : undefined,
          LastRunCompleted: wf.LastRun?.CompletedOn ? wf.LastRun.CompletedOn.toISOString() : undefined,
        },
        lastUpdated: Date.now(),
      });
    }
    return resources;
  },
};

// ─── Glue Triggers ──────────────────────────────────────────────────────────

const glueTriggerDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.glue(scope);
    const resources: ResourceNode[] = [];

    const triggers: Trigger[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await platform.scheduler.run("glue", "GetTriggers", () =>
        client.send(new GetTriggersCommand({ NextToken: nextToken, MaxResults: 100 }))
      );
      for (const t of resp.Triggers ?? []) triggers.push(t);
      nextToken = resp.NextToken;
      pages += 1;
      if (shouldStopPagination({
        pages, nextToken, label: "glue:GetTriggers",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    for (const t of triggers) {
      if (!t.Name) continue;
      const actions = t.Actions ?? [];
      const arn = buildGlueTriggerArn(scope.region, scope.accountId, t.Name);
      resources.push({
        arn,
        id: t.Name,
        type: ResourceTypes.glueTrigger,
        service: "glue",
        accountId: scope.accountId,
        region: scope.region,
        name: t.Name,
        tags: {},
        rawJson: {
          TriggerName: t.Name,
          TriggerType: t.Type,
          State: t.State,
          Schedule: t.Schedule,
          Description: t.Description,
          WorkflowName: t.WorkflowName,
          ActionCount: actions.length,
          // First action target summary — most triggers fire a single job
          // or crawler so this is informative without being noisy.
          FirstActionTarget: actions[0]?.JobName ?? actions[0]?.CrawlerName,
          FirstActionKind: actions[0]?.JobName ? "Job" : actions[0]?.CrawlerName ? "Crawler" : undefined,
          PredicateLogical: t.Predicate?.Logical,
          PredicateConditionCount: t.Predicate?.Conditions?.length,
          EventBatchingSize: t.EventBatchingCondition?.BatchSize,
        },
        lastUpdated: Date.now(),
      });
    }
    return resources;
  },
};

export function registerGluePlugin(registry: ResourceRegistry): void {
  // ── ETL Jobs ──
  registry.register({
    type: ResourceTypes.glueJob,
    service: "glue",
    serviceLabel: "AWS Glue",
    displayName: "ETL Job",
    scope: "regional",
    ttlSeconds: 180,
    discoverer: glueJobDiscoverer,
    getTreeDescription: (resource) => {
      const state = resource.rawJson.LastRunState as string | undefined;
      const type = resource.rawJson.JobType as string | undefined;
      const bits: string[] = [];
      if (type) bits.push(type);
      if (state) bits.push(`last: ${state}`);
      return bits.length > 0 ? bits.join(" · ") : undefined;
    },
    detailFields: [
      { label: "Job Name", path: "id", source: "resource" },
      { label: "Type", path: "JobType", source: "raw" },
      { label: "Glue Version", path: "GlueVersion", source: "raw" },
      { label: "Worker Type", path: "WorkerType", source: "raw" },
      { label: "Workers", path: "NumberOfWorkers", source: "raw" },
      { label: "Script", path: "ScriptLocation", source: "raw" },
      { label: "IAM Role", path: "Role", source: "raw" },
      { label: "Last Run State", path: "LastRunState", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/gluestudio/home?region=${resource.region}#/editor/job/${encodeURIComponent(resource.id)}/runs`,
  });

  // ── Crawlers ──
  registry.register({
    type: ResourceTypes.glueCrawler,
    service: "glue",
    serviceLabel: "AWS Glue",
    displayName: "Crawler",
    scope: "regional",
    ttlSeconds: 180,
    discoverer: glueCrawlerDiscoverer,
    getTreeDescription: (resource) => {
      const state = resource.rawJson.State as string | undefined;
      const db = resource.rawJson.DatabaseName as string | undefined;
      const bits: string[] = [];
      if (state) bits.push(state.toLowerCase());
      if (db) bits.push(`→ ${db}`);
      return bits.length > 0 ? bits.join(" · ") : undefined;
    },
    detailFields: [
      { label: "Crawler", path: "id", source: "resource" },
      { label: "State", path: "State", source: "raw" },
      { label: "Database", path: "DatabaseName", source: "raw" },
      { label: "Targets", path: "TargetSummary", source: "raw" },
      { label: "Schedule", path: "Schedule", source: "raw" },
      { label: "Last Crawl Status", path: "LastCrawlStatus", source: "raw" },
      { label: "IAM Role", path: "Role", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/glue/home?region=${resource.region}#/v2/data-catalog/crawlers/view/${encodeURIComponent(resource.id)}`,
  });

  // ── Workflows ──
  registry.register({
    type: ResourceTypes.glueWorkflow,
    service: "glue",
    serviceLabel: "AWS Glue",
    displayName: "Workflow",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: glueWorkflowDiscoverer,
    getTreeDescription: (resource) => {
      const lastStatus = resource.rawJson.LastRunStatus as string | undefined;
      return lastStatus ? `last: ${lastStatus}` : undefined;
    },
    detailFields: [
      { label: "Workflow", path: "id", source: "resource" },
      { label: "Description", path: "Description", source: "raw" },
      { label: "Max Concurrent Runs", path: "MaxConcurrentRuns", source: "raw" },
      { label: "Last Run Status", path: "LastRunStatus", source: "raw" },
      { label: "Last Run Started", path: "LastRunStarted", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/glue/home?region=${resource.region}#/v2/etl-configuration/workflows/view/${encodeURIComponent(resource.id)}`,
  });

  // ── Triggers ──
  registry.register({
    type: ResourceTypes.glueTrigger,
    service: "glue",
    serviceLabel: "AWS Glue",
    displayName: "Trigger",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: glueTriggerDiscoverer,
    getTreeDescription: (resource) => {
      const t = resource.rawJson.TriggerType as string | undefined;
      const s = resource.rawJson.State as string | undefined;
      const bits: string[] = [];
      if (t) bits.push(t.toLowerCase());
      if (s) bits.push(s.toLowerCase());
      return bits.length > 0 ? bits.join(" · ") : undefined;
    },
    detailFields: [
      { label: "Trigger", path: "id", source: "resource" },
      { label: "Type", path: "TriggerType", source: "raw" },
      { label: "State", path: "State", source: "raw" },
      { label: "Schedule", path: "Schedule", source: "raw" },
      { label: "Workflow", path: "WorkflowName", source: "raw" },
      { label: "Targets", path: "ActionCount", source: "raw" },
    ],
    buildConsoleUrl: (resource) =>
      `https://${resource.region}.console.aws.amazon.com/glue/home?region=${resource.region}#/v2/etl-configuration/triggers/view/${encodeURIComponent(resource.id)}`,
  });
}
