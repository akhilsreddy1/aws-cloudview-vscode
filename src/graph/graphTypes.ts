import type { Edge, ResourceDetailsPayload, ResourceNode } from "../core/contracts";
import { inferScopeFromArn } from "../core/resourceUtils";

/** Full message payload sent to the graph webview for initial render or refresh. */
export interface GraphMessagePayload {
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
  rootArn: string;
}

/**
 * Lightweight serializable node descriptor sent to the graph webview.
 * Contains only the fields needed for rendering; the full {@link ResourceNode}
 * is not sent to avoid bloating the message payload.
 */
export interface GraphNodePayload {
  arn: string;
  id: string;
  label: string;
  type: string;
  service: string;
  accountId: string;
  region: string;
}

/** Serializable edge descriptor sent to the graph webview. */
export interface GraphEdgePayload {
  id: string;
  source: string;
  target: string;
  label: string;
}

/** A single entry in the graph search-results dropdown. */
export interface SearchResultPayload {
  arn: string;
  label: string;
  subtitle: string;
}

/** Converts a {@link ResourceNode} to the slim webview payload format. */
export function toGraphNodePayload(resource: ResourceNode): GraphNodePayload {
  const inferred = inferScopeFromArn(resource.arn);
  return {
    arn: resource.arn,
    id: resource.id,
    label: resource.name || resource.id,
    type: resource.type,
    service: resource.service,
    accountId: resource.accountId || inferred.accountId || "",
    region: resource.region || inferred.region || ""
  };
}

/** Converts an {@link Edge} to the slim webview payload format. */
export function toGraphEdgePayload(edge: Edge): GraphEdgePayload {
  return {
    id: `${edge.fromArn}|${edge.relationshipType}|${edge.toArn}`,
    source: edge.fromArn,
    target: edge.toArn,
    label: edge.relationshipType
  };
}

export interface ResourceDetailsMessagePayload extends ResourceDetailsPayload {}
