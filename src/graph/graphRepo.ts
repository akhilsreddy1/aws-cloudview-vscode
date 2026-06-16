import type { Edge } from "../core/contracts";

/**
 * Direction of graph traversal relative to the source node:
 * - `"out"` — follow edges where source is `from_arn` (downstream).
 * - `"in"`  — follow edges where source is `to_arn` (upstream).
 * - `"both"` — traverse both directions; an edge is followed from either endpoint.
 */
export type TraversalDirection = "out" | "in" | "both";

/** Options for a bounded-depth graph traversal from one root ARN. */
export interface TraverseOptions {
  /** Maximum hops from the root (1 = direct neighbors). */
  depth: number;
  direction: TraversalDirection;
  /**
   * Optional allowlist of edge `relationship_type` values. Edges whose type
   * is not in this list are skipped during the walk.
   */
  allowedRelationships?: string[];
  /**
   * Optional allowlist of AWS account IDs. Edges whose denormalized
   * `account_id` is not in this list are skipped; `NULL` account rows are
   * always allowed through so legacy edges remain visible.
   */
  accountIds?: string[];
  /** Hard cap on the number of distinct ARNs returned. Defaults to 5000. */
  maxNodes?: number;
}

/** Options for a bounded-depth path-finding query between two ARNs. */
export interface PathOptions {
  /** Maximum hops to consider; paths longer than this are discarded. */
  depth: number;
  direction: TraversalDirection;
  allowedRelationships?: string[];
  /** Upper bound on number of paths returned, ordered shortest-first. */
  maxPaths?: number;
}

/** Options for extracting a subgraph from a known seed set. */
export interface SubgraphOptions {
  direction?: TraversalDirection;
  allowedRelationships?: string[];
  accountIds?: string[];
  maxNodes?: number;
}

/**
 * The result of a traversal / subgraph query. Returned as plain ARN lists and
 * edges so the caller can hydrate `ResourceNode` objects from the
 * `ResourceRepo` independently (keeps this interface store-agnostic and
 * avoids N+1 joins inside the repo).
 */
export interface SubgraphResult {
  /** All ARNs visited during the walk, including the root(s). */
  arns: string[];
  /** All edges walked to produce the result. */
  edges: Edge[];
}

/**
 * A single path from source to target, expressed as the ordered list of edges
 * traversed. Length `n` means an `n`-hop path.
 */
export type GraphPath = Edge[];

/**
 * Store-agnostic graph traversal primitives. Implementations are free to
 * push computation down to the underlying engine (recursive CTEs in SQLite,
 * Cypher in a future graph DB) as long as the return contract holds.
 *
 * This is the single seam for graph queries — callers never touch SQL or
 * driver-specific types. Swapping the backing store means implementing this
 * interface against the new store and flipping the wiring in `extension.ts`.
 */
export interface GraphRepo {
  /**
   * Walks outward from `rootArn` up to `opts.depth` hops, respecting
   * direction and filter options. Returns visited ARNs plus the edges
   * walked (so callers can render both nodes and edges without a second
   * round-trip).
   */
  traverseFrom(rootArn: string, opts: TraverseOptions): Promise<SubgraphResult>;

  /**
   * Returns up to `opts.maxPaths` paths from `fromArn` to `toArn`, ordered
   * shortest-first (by edge count). Cycles are broken during the walk. An
   * empty array means no path exists within `opts.depth` hops.
   */
  pathBetween(fromArn: string, toArn: string, opts: PathOptions): Promise<GraphPath[]>;

  /**
   * Expands a seed set of ARNs to form a connected subgraph: starts from
   * each seed, walks `depth` hops in `direction`, merges the results,
   * and returns the deduplicated node and edge sets. Useful for service-
   * map style rendering where the caller already has a candidate node set.
   */
  subgraph(arns: string[], depth: number, opts?: SubgraphOptions): Promise<SubgraphResult>;

  /**
   * Counts distinct ARNs reachable from `rootArn` within `depth` hops.
   * Cheaper than `traverseFrom` because it doesn't need to materialize
   * the edge list; useful for UI badges ("42 resources downstream").
   */
  countReachable(rootArn: string, depth: number, direction: TraversalDirection): Promise<number>;
}
