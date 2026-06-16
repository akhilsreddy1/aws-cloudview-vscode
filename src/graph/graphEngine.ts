import type { Edge, GraphExpandResult, ResourceNode } from "../core/contracts";
import type { CloudViewPlatform } from "../core/platform";
import type { GraphPath, TraversalDirection } from "./graphRepo";

/**
 * Traverses the resource graph stored in SQLite, running relationship
 * resolvers on-demand as it walks the graph. Stale resources are
 * re-discovered before expansion via the {@link DiscoveryCoordinator}.
 *
 * All traversal results are de-duplicated by ARN; edges are de-duplicated
 * by `fromArn|relationshipType|toArn`.
 */
export class GraphEngine {
  public constructor(private readonly platform: CloudViewPlatform) {}

  /**
   * Expands the graph starting from `rootArn` up to `depth` hops.
   * At each hop, every registered {@link RelationshipResolver} for the
   * frontier node's type is run (subject to TTL caching). Nodes not in
   * `allowedTypes` are filtered from the result if the array is provided.
   *
   * Returns an empty result if the root ARN is not found in the cache.
   */
  public async expand(rootArn: string, depth: number, allowedTypes?: string[]): Promise<GraphExpandResult> {
    const nodes = new Map<string, ResourceNode>();
    const edges = new Map<string, Edge>();

    const cachedRoot = await this.platform.resourceRepo.getByArn(rootArn);
    const root = cachedRoot ? await this.ensureResourceFresh(cachedRoot) : undefined;
    if (!root) {
      return { rootArn, nodes: [], edges: [] };
    }

    nodes.set(root.arn, root);

    let frontier = [root];
    for (let level = 0; level < depth; level += 1) {
      const nextFrontier: ResourceNode[] = [];

      for (const source of frontier) {
        const discovered = await this.expandSource(source, allowedTypes);
        for (const edge of discovered.edges) {
          if (allowedTypes && discovered.nodesByArn.has(edge.toArn)) {
            const target = discovered.nodesByArn.get(edge.toArn);
            if (target && !allowedTypes.includes(target.type)) {
              continue;
            }
          }

          edges.set(`${edge.fromArn}|${edge.relationshipType}|${edge.toArn}`, edge);
        }

        for (const node of discovered.nodes) {
          if (allowedTypes && !allowedTypes.includes(node.type) && node.arn !== rootArn) {
            continue;
          }

          if (!nodes.has(node.arn)) {
            nodes.set(node.arn, node);
            nextFrontier.push(node);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }

    return {
      rootArn,
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values())
    };
  }

  /**
   * Expands multiple root ARNs independently and merges the results into a
   * single de-duplicated graph. Useful for multi-select graph views.
   */
  public async expandMultiRoot(rootArns: string[], depth: number): Promise<GraphExpandResult> {
    const allNodes = new Map<string, ResourceNode>();
    const allEdges = new Map<string, Edge>();

    for (const rootArn of rootArns) {
      const result = await this.expand(rootArn, depth);
      for (const node of result.nodes) {
        allNodes.set(node.arn, node);
      }
      for (const edge of result.edges) {
        allEdges.set(`${edge.fromArn}|${edge.relationshipType}|${edge.toArn}`, edge);
      }
    }

    return {
      rootArn: rootArns[0] ?? "",
      nodes: Array.from(allNodes.values()),
      edges: Array.from(allEdges.values()),
    };
  }

  /**
   * Builds a high-level service map for an AWS account by loading up to
   * `maxNodesPerService` resources per service and then delegating to
   * {@link GraphRepo.subgraph} to extract the edges connecting them.
   * Additional referenced nodes are hydrated from the cache to avoid
   * dangling edge endpoints.
   *
   * @param accountId - The AWS account ID to scope the query to.
   * @param services - Optional allowlist of service IDs; omit to include all.
   * @param maxNodesPerService - Cap on nodes per service to keep the graph readable.
   */
  public async buildServiceMap(
    accountIds: string[],
    services?: string[],
    maxNodesPerService = 50
  ): Promise<GraphExpandResult> {
    const resources = await this.platform.resourceRepo.listByAccounts(accountIds, services);

    const nodesByService = new Map<string, ResourceNode[]>();
    for (const r of resources) {
      const list = nodesByService.get(r.service) ?? [];
      list.push(r);
      nodesByService.set(r.service, list);
    }

    const selectedResources: ResourceNode[] = [];
    for (const [, svcResources] of nodesByService) {
      selectedResources.push(...svcResources.slice(0, maxNodesPerService));
    }

    const nodeMap = new Map<string, ResourceNode>();
    for (const r of selectedResources) { nodeMap.set(r.arn, r); }

    const arns = selectedResources.map((r) => r.arn);
    // `subgraph` with depth=0 is a pure "edges among these nodes" extraction —
    // no traversal, just the induced-subgraph edges. Scope the query to the
    // account so we never walk into neighbouring tenants.
    const { edges } = await this.platform.graphRepo.subgraph(arns, 0, {
      direction: "both",
      accountIds
    });

    // Hydrate any dangling endpoints from the cache so the UI has full nodes.
    const danglingArns = edges
      .flatMap((e) => [e.fromArn, e.toArn])
      .filter((a) => !nodeMap.has(a));
    if (danglingArns.length > 0) {
      const resolved = await this.platform.resourceRepo.getByArns(Array.from(new Set(danglingArns)));
      for (const r of resolved) { nodeMap.set(r.arn, r); }
    }

    return {
      rootArn: arns[0] ?? "",
      nodes: Array.from(nodeMap.values()),
      edges,
    };
  }

  /**
   * Returns the immediate neighbors of `arn` — all nodes connected by at
   * least one edge in either direction, plus the source node itself.
   * Delegates the walk to {@link GraphRepo.traverseFrom}.
   */
  public async neighbors(arn: string): Promise<GraphExpandResult> {
    const node = await this.platform.resourceRepo.getByArn(arn);
    if (!node) {
      return { rootArn: arn, nodes: [], edges: [] };
    }

    const { arns, edges } = await this.platform.graphRepo.traverseFrom(arn, {
      depth: 1,
      direction: "both"
    });
    const neighborArns = arns.filter((a) => a !== arn);
    const neighborNodes = await this.platform.resourceRepo.getByArns(neighborArns);

    return {
      rootArn: arn,
      nodes: [node, ...neighborNodes],
      edges
    };
  }

  /**
   * Multi-hop walk that reads directly from the persisted graph with no TTL
   * refresh side-effects. Use this when you trust the cache is fresh (e.g.
   * right after `expand()` populated it, or for read-only service maps).
   * Returns hydrated `ResourceNode` objects for every visited ARN that's
   * still in the cache.
   */
  public async traverseCached(
    rootArn: string,
    depth: number,
    direction: TraversalDirection = "out",
    opts?: { allowedTypes?: string[]; accountIds?: string[]; maxNodes?: number }
  ): Promise<GraphExpandResult> {
    const { arns, edges } = await this.platform.graphRepo.traverseFrom(rootArn, {
      depth,
      direction,
      accountIds: opts?.accountIds,
      maxNodes: opts?.maxNodes
    });
    const nodes = await this.platform.resourceRepo.getByArns(arns);
    const filteredNodes = opts?.allowedTypes
      ? nodes.filter((n) => n.arn === rootArn || opts.allowedTypes!.includes(n.type))
      : nodes;
    return {
      rootArn,
      nodes: filteredNodes,
      edges
    };
  }

  /**
   * Finds up to `maxPaths` shortest paths between two resources, returned as
   * lists of edges. Returns an empty array if no path exists within `depth`
   * hops. Delegates to {@link GraphRepo.pathBetween}.
   */
  public async findPaths(
    fromArn: string,
    toArn: string,
    depth: number,
    direction: TraversalDirection = "out",
    maxPaths = 3
  ): Promise<GraphPath[]> {
    return this.platform.graphRepo.pathBetween(fromArn, toArn, { depth, direction, maxPaths });
  }

  /** Delegates to {@link ResourceRepo.search} for full-text resource lookup. */
  public async search(query: string, limit = 50): Promise<ResourceNode[]> {
    return this.platform.resourceRepo.search(query, limit);
  }

  private async ensureResourceFresh(resource: ResourceNode): Promise<ResourceNode> {
    const definition = this.platform.resourceRegistry.get(resource.type);
    if (!definition) {
      return resource;
    }

    if (!this.platform.resourceRepo.isStale(resource, definition.ttlSeconds)) {
      return resource;
    }

    const profileName = await this.findProfileName(resource.accountId);
    if (!profileName) {
      return resource;
    }

    await this.platform.discoveryCoordinator.refreshDefinition(
      {
        profileName,
        accountId: resource.accountId,
        region: resource.region
      },
      definition,
      { force: true }
    );

    return (await this.platform.resourceRepo.getByArn(resource.arn)) ?? resource;
  }

  private async expandSource(
    source: ResourceNode,
    allowedTypes?: string[]
  ): Promise<{ nodes: ResourceNode[]; edges: Edge[]; nodesByArn: Map<string, ResourceNode> }> {
    const resolvers = this.platform.resolverRegistry.getForSourceType(source.type);
    const collectedNodes = new Map<string, ResourceNode>();

    for (const resolver of resolvers) {
      const scopeKey = `${source.arn}|${resolver.relationshipType}`;
      const shouldRun = await this.platform.discoveryJobRepo.shouldRun(scopeKey, resolver.ttlSeconds, false);
      if (!shouldRun) {
        continue;
      }

      await this.platform.discoveryJobRepo.markRunning({
        scopeKey,
        jobType: "relationship-resolution",
        profileName: (await this.findProfileName(source.accountId)) ?? "",
        accountId: source.accountId,
        region: source.region,
        service: source.service,
        resourceType: source.type,
        status: "running",
        metadataJson: {
          relationshipType: resolver.relationshipType
        }
      });

      try {
        const resolution = await resolver.resolve({
          source,
          platform: this.platform
        });
        await this.platform.resourceRepo.upsertMany(resolution.nodes);
        await this.platform.edgeRepo.replaceRelationshipSet(source.arn, resolver.relationshipType, resolution.edges);
        await this.platform.discoveryJobRepo.markSuccess(scopeKey, resolver.ttlSeconds);
      } catch (error) {
        // A broken resolver must not abort the whole graph expansion —
        // record the failure, log it, and continue with the remaining
        // resolvers / frontier. The cached edges from previous runs (if
        // any) are still returned below, so the graph degrades gracefully.
        await this.platform.discoveryJobRepo.markFailure(scopeKey, error);
        this.platform.logger.warn(
          `Resolver ${resolver.id} failed for ${source.arn} (${resolver.relationshipType}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const allEdges = await this.platform.edgeRepo.listOutgoing(source.arn);
    const targetArns = Array.from(new Set(allEdges.map((edge) => edge.toArn)));
    const targets = await this.platform.resourceRepo.getByArns(targetArns);
    for (const node of [source, ...targets]) {
      collectedNodes.set(node.arn, node);
    }

    const nodesByArn = collectedNodes;
    const edges = allowedTypes
      ? allEdges.filter((edge) => {
          const target = nodesByArn.get(edge.toArn);
          return !target || allowedTypes.includes(target.type);
        })
      : allEdges;

    return {
      nodes: Array.from(nodesByArn.values()),
      edges,
      nodesByArn
    };
  }

  private async findProfileName(accountId: string): Promise<string | undefined> {
    return this.platform.sessionManager.findProfileNameByAccountId(accountId);
  }
}
