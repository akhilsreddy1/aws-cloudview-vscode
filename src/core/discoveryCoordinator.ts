import type { CloudViewPlatform } from "./platform";
import type { AwsScope, DiscoveryContext, ResourceNode, ResourceTypeDefinition } from "./contracts";

/** Options controlling whether a discovery run may use cached results. */
export interface RefreshOptions {
  /** When `true`, bypass the TTL gate and force a fresh API call. */
  force?: boolean;
  /**
   * Cooperative cancellation signal. When the caller (typically the
   * "Refresh Resources" progress notification) cancels, the coordinator
   * stops scheduling new service-scope runs and discoverers with pagination
   * loops break out at the next page boundary. Structurally compatible
   * with `vscode.CancellationToken`.
   */
  cancellation?: { readonly isCancellationRequested: boolean };
  /**
   * Optional progress callback fired after each service-scope completes
   * during {@link DiscoveryCoordinator.refreshSelectedProfiles}. The UI layer
   * uses this to update the `withProgress` notification with a "[N / total]"
   * counter and increment the progress bar. The total is known up-front
   * (profiles × regions × services-matching-scope), so consumers can compute
   * an accurate percentage.
   */
  onProgress?: (event: RefreshProgressEvent) => void;
}

/** Per-service-scope progress event emitted by `refreshSelectedProfiles`. */
export interface RefreshProgressEvent {
  /** Work units completed so far (1-based once the first scope finishes). */
  completed: number;
  /** Total work units that will be attempted in this refresh run. */
  total: number;
  /** The scope + service that just finished. */
  current: { profileName: string; accountId: string; region: string; service: string };
}

/**
 * Orchestrates AWS resource discovery and relationship resolution across
 * profiles, regions, and services.
 * Every time user tries to refresh resources, this coordinator is called and it will call the refreshServiceScope for each service.
 * refreshServiceScope will call the refreshDefinition for each definition.
 * refreshDefinition will call the discoverer to get the resources for the resource type in the scope.
 * If the discoverer is streaming, it will return a page of resources at a time
 * and call persistPage to save them. If it is not streaming, it will return a full list of resources.
 * If the discoverer is not streaming, it will persist everything it returned.
 * If the discoverer is streaming, it will persist any trailing rows not yet streamed (keeps backwards-compat with refactored
 * discoverers that push per page but still build the full list).
 * If the discoverer is streaming, it will tombstone stale rows: anything cached under this scope/type that
 * 
 * Everything funnels through this coordinator to refresh the resources for the selected profiles and regions and services.
 *
 * Discovery is TTL-gated via {@link DiscoveryJobRepo}: a job is skipped if its
 * `nextEligibleRun` timestamp has not yet elapsed (unless `force` is set).
 * Results are persisted to SQLite via {@link ResourceRepo} so they survive
 * extension restarts.
 */
export class DiscoveryCoordinator {
  public constructor(private readonly platform: CloudViewPlatform) {}

  /**
   * Discovers all resource types belonging to `service` within the given
   * `scope`, skipping types that don't match the scope's region kind
   * (regional vs. global). Uses `Promise.allSettled` so a single definition
   * failure never blocks the others — failures are logged and the successful
   * partial result is still returned.
   */
  public async refreshServiceScope(scope: AwsScope, service: string, options: RefreshOptions = {}): Promise<ResourceNode[]> {
    const definitions = this.platform.resourceRegistry
      .getByService(service)
      .filter((definition) => this.matchesScope(definition, scope.region));

    const settled = await Promise.allSettled(
      definitions.map((definition) => this.refreshDefinition(scope, definition, options))
    );

    const combined: ResourceNode[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        combined.push(...outcome.value);
      } else {
        const def = definitions[index];
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        this.platform.logger.warn(
          `Discovery partial failure: ${def.type} in ${scope.profileName}/${scope.region}: ${message}`
        );
      }
    });
    return combined;
  }

  /**
   * Discovers resources for a single {@link ResourceTypeDefinition} within
   * `scope`. If the cached job is still within TTL (and `force` is not set),
   * returns the cached rows from SQLite instead of calling AWS.
   *
   * Resource persistence is incremental: discoverers may call
   * `ctx.persistPage(batch, nextToken)` per page so progress survives
   * crashes and pagination can resume via `ctx.resumeToken` on retry.
   * At the end of a successful run, rows in the (accountId, region, type)
   * scope that weren't seen are tombstoned (deleted) — the cache stays
   * consistent with AWS even when resources are removed.
   */
  public async refreshDefinition(scope: AwsScope, definition: ResourceTypeDefinition, options: RefreshOptions = {}): Promise<ResourceNode[]> {
    // `??` (not `||`) so a deliberate `ttlSeconds: 0` means "never cache" rather than falling through to the default.
    const ttlSeconds = definition.ttlSeconds ?? this.platform.getConfig().defaultTtlSeconds;
    const scopeKey = `${scope.profileName}|${scope.accountId}|${scope.region}|${definition.type}`;
    const shouldRun = await this.platform.discoveryJobRepo.shouldRun(scopeKey, ttlSeconds, options.force ?? false);

    if (!shouldRun) {
      return this.platform.resourceRepo.listByScope({
        accountId: scope.accountId,
        region: scope.region,
        service: definition.service,
        type: definition.type
      });
    }

    const resumeToken = await this.safeGetCheckpoint(scopeKey);

    await this.platform.discoveryJobRepo.markRunning({
      scopeKey,
      jobType: "resource-discovery",
      profileName: scope.profileName,
      accountId: scope.accountId,
      region: scope.region,
      service: definition.service,
      resourceType: definition.type,
      status: "running",
      metadataJson: {}
    });

    const seenArns = new Set<string>();
    const streamed: ResourceNode[] = [];
    let streamedPages = 0;

    const context: DiscoveryContext = {
      scope,
      definition,
      platform: this.platform,
      resumeToken,
      cancellation: options.cancellation,
      persistPage: async (batch: ResourceNode[], nextToken?: string) => {
        if (batch.length > 0) {
          await this.platform.resourceRepo.upsertMany(batch);
          for (const node of batch) {
            seenArns.add(node.arn);
            streamed.push(node);
          }
        }
        streamedPages += 1;
        await this.safeSaveCheckpoint(scopeKey, nextToken);
      }
    };

    try {
      // Call the discoverer to get the resources for the resource type in the scope
      const returned = await definition.discoverer.discover(context);
      // If the discoverer is streaming, it will return a page of resources at a time
      // and call persistPage to save them. If it is not streaming, it will return a full list of resources.
      if (streamedPages === 0) {
        // Non-streaming discoverer: persist everything it returned.
        if (returned.length > 0) {
          await this.platform.resourceRepo.upsertMany(returned);
        }
        for (const node of returned) {
          seenArns.add(node.arn);
        }
      } else if (returned && returned.length > 0) {
        // Streaming discoverer that also returned a full array — persist any
        // trailing rows not yet streamed (keeps backwards-compat with refactored
        // discoverers that push per page but still build the full list).
        const trailing = returned.filter((node) => !seenArns.has(node.arn));
        if (trailing.length > 0) {
          await this.platform.resourceRepo.upsertMany(trailing);
          for (const node of trailing) {
            seenArns.add(node.arn);
          }
        }
      }

      // Tombstone stale rows: anything cached under this scope/type that
      // wasn't seen this run has been deleted from AWS.
      try {
        const removed = await this.platform.resourceRepo.deleteMissingInScope({
          accountId: scope.accountId,
          region: scope.region,
          type: definition.type,
          keepArns: seenArns
        });
        if (removed > 0) {
          this.platform.logger.info(
            `Tombstoned ${removed} stale ${definition.type} row(s) in ${scope.accountId}/${scope.region}`
          );
        }
      } catch (tombstoneError) {
        // Tombstone failure shouldn't fail the discovery — cache just
        // keeps the stale rows until next run.
        this.platform.logger.warn(
          `Failed to tombstone stale ${definition.type} rows: ${tombstoneError instanceof Error ? tombstoneError.message : tombstoneError}`
        );
      }

      await this.platform.discoveryJobRepo.markSuccess(scopeKey, ttlSeconds);

      if (streamedPages > 0) {
        return streamed;
      }
      return returned;
    } catch (error) {
      await this.platform.discoveryJobRepo.markFailure(scopeKey, error);
      this.platform.logger.error(`Discovery failed for ${definition.type} in ${scope.profileName}/${scope.region}`, error);
      throw error;
    }
  }

  private async safeGetCheckpoint(scopeKey: string): Promise<string | undefined> {
    const repo = this.platform.discoveryJobRepo as { getCheckpoint?: (key: string) => Promise<string | undefined> };
    if (typeof repo.getCheckpoint !== "function") {
      return undefined;
    }
    try {
      return await repo.getCheckpoint(scopeKey);
    } catch {
      return undefined;
    }
  }

  private async safeSaveCheckpoint(scopeKey: string, token: string | undefined): Promise<void> {
    const repo = this.platform.discoveryJobRepo as { saveCheckpoint?: (key: string, token: string | undefined) => Promise<void> };
    if (typeof repo.saveCheckpoint !== "function") {
      return;
    }
    try {
      await repo.saveCheckpoint(scopeKey, token);
    } catch {
      // Checkpoint is a best-effort optimization; swallow failures so they
      // never mask the real discovery outcome.
    }
  }

  /**
   * Runs a full refresh for every selected profile, every configured region,
   * and every registered service. This is the top-level entry point triggered
   * by the "Refresh Resources" command.
   * @param options - The refresh options.
   * @returns A promise that resolves when the refresh is complete.
   */
  public async refreshSelectedProfiles(options: RefreshOptions = {}): Promise<void> {
    const profiles = await this.platform.sessionManager.getSelectedProfileSessions();
    const services = this.platform.resourceRegistry.listServices();
    const regions = this.platform.sessionManager.getConfiguredRegions();

    // Pre-compute total work units so the progress bar shows accurate
    // [N / total] counts. We can't just multiply (profiles × regions ×
    // services) because global services (IAM, S3, etc.) only run in the
    // "global" pseudo-region, not in each real one.
    const total = this.countWorkUnits(profiles.length, regions, services);
    let completed = 0;

    for (const session of profiles) {
      if (options.cancellation?.isCancellationRequested) return;
      for (const region of regions) {
        if (options.cancellation?.isCancellationRequested) return;
        const scope: AwsScope = {
          profileName: session.profileName,
          accountId: session.accountId,
          region
        };

        for (const service of services) {
          if (options.cancellation?.isCancellationRequested) return;
          const hasMatchingDefinition = this.platform.resourceRegistry
            .getByService(service.id)
            .some((definition) => this.matchesScope(definition, region));

          if (hasMatchingDefinition) {
            await this.refreshServiceScope(scope, service.id, options);
            completed += 1;
            options.onProgress?.({
              completed,
              total,
              current: {
                profileName: session.profileName,
                accountId: session.accountId,
                region,
                service: service.id,
              },
            });
          }
        }
      }
    }
  }

  /**
   * Counts how many `(profile, region, service)` tuples will actually be
   * dispatched. Mirrors the filtering logic in `refreshSelectedProfiles`
   * exactly so progress totals match what the loop iterates.
   */
  private countWorkUnits(
    profileCount: number,
    regions: string[],
    services: ReadonlyArray<{ id: string }>,
  ): number {
    let perProfilePerRegion = 0;
    const perRegion = new Map<string, number>();
    for (const region of regions) {
      let n = 0;
      for (const service of services) {
        const has = this.platform.resourceRegistry
          .getByService(service.id)
          .some((d) => this.matchesScope(d, region));
        if (has) n += 1;
      }
      perRegion.set(region, n);
      perProfilePerRegion += n;
    }
    void perRegion; // available for future per-region progress refinement
    return profileCount * perProfilePerRegion;
  }

  private matchesScope(definition: ResourceTypeDefinition, region: string): boolean {
    return definition.scope === "global" ? region === "global" : region !== "global";
  }
}
