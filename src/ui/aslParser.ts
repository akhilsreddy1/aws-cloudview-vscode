/**
 * Amazon States Language (ASL) → graph nodes/edges.
 *
 * Handles the state types users actually see in production: Task, Choice,
 * Parallel, Map, Wait, Pass, Succeed, Fail. Nested workflows inside
 * `Parallel.Branches[]` and `Map.ItemProcessor` (or the older `Map.Iterator`)
 * are hoisted into the same node list — the outer Parallel / Map state
 * becomes a Cytoscape compound parent, and each branch's states nest
 * inside it. Cross-branch transitions aren't possible in ASL, so the
 * nested-scope simplification is safe.
 *
 * State names are namespaced with a `<parent>::<name>` prefix when they
 * live inside a branch, so identical state names across branches don't
 * collide as node IDs.
 */

export interface AslNode {
  /** Unique node id — namespaced when inside a Parallel/Map branch. */
  id: string;
  /** Bare state name from the ASL definition (used for execution overlay). */
  name: string;
  /** ASL type: Task, Choice, Parallel, Map, Wait, Pass, Succeed, Fail. */
  type: string;
  comment?: string;
  /** Compound parent id (Parallel/Map state) if this node lives in a branch. */
  parent?: string;
  isStart?: boolean;
  isEnd?: boolean;
  /** For Task: the invoked resource ARN (Lambda / SNS / etc.). */
  resource?: string;
}

export interface AslEdge {
  source: string;
  target: string;
  label?: string;
  /** Set on choice-branch edges (rendered with a dotted style). */
  isChoice?: boolean;
  /** Set on catcher edges (rendered red, dotted). */
  isCatch?: boolean;
}

export interface AslGraph {
  nodes: AslNode[];
  edges: AslEdge[];
  /** Top-level start-state id. Handy for centering the initial view. */
  startId?: string;
}

interface AslState {
  Type?: string;
  Comment?: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Choices?: Array<{ Next?: string; Variable?: string } & Record<string, unknown>>;
  Catch?: Array<{ Next?: string; ErrorEquals?: string[] }>;
  Branches?: AslWorkflow[];
  Iterator?: AslWorkflow;
  ItemProcessor?: AslWorkflow;
}

interface AslWorkflow {
  StartAt?: string;
  States?: Record<string, AslState>;
}

/**
 * Parse a state machine definition (JSON string) into a nodes/edges graph.
 * Throws on malformed JSON so callers can surface a clear error banner.
 */
export function parseASL(definitionJson: string): AslGraph {
  const def = JSON.parse(definitionJson) as AslWorkflow;
  const nodes: AslNode[] = [];
  const edges: AslEdge[] = [];
  parseWorkflow(def, undefined, nodes, edges);
  const startId = def.StartAt;
  return { nodes, edges, startId };
}

function parseWorkflow(
  wf: AslWorkflow,
  parent: string | undefined,
  nodes: AslNode[],
  edges: AslEdge[],
): void {
  const states = wf.States ?? {};
  const nsPrefix = parent ? `${parent}::` : "";

  for (const [name, state] of Object.entries(states)) {
    const nodeId = `${nsPrefix}${name}`;
    const type = state.Type ?? "Unknown";

    nodes.push({
      id: nodeId,
      name,
      type,
      comment: state.Comment,
      parent,
      isStart: name === wf.StartAt,
      isEnd: state.End === true || type === "Succeed" || type === "Fail",
      resource: state.Resource,
    });

    // Simple linear transition.
    if (state.Next) {
      edges.push({ source: nodeId, target: `${nsPrefix}${state.Next}` });
    }

    // Choice branches — one edge per Choices[].Next plus Default.
    if (type === "Choice") {
      const choices = state.Choices ?? [];
      choices.forEach((choice, i) => {
        if (choice.Next) {
          edges.push({
            source: nodeId,
            target: `${nsPrefix}${choice.Next}`,
            label: choiceLabel(choice, i),
            isChoice: true,
          });
        }
      });
      if (state.Default) {
        edges.push({
          source: nodeId,
          target: `${nsPrefix}${state.Default}`,
          label: "default",
          isChoice: true,
        });
      }
    }

    // Catchers on Task/Parallel/Map — error-flow edges.
    if (Array.isArray(state.Catch)) {
      for (const catcher of state.Catch) {
        if (catcher.Next) {
          const errs = (catcher.ErrorEquals ?? []).join(", ");
          edges.push({
            source: nodeId,
            target: `${nsPrefix}${catcher.Next}`,
            label: errs ? `catch: ${errs}` : "catch",
            isCatch: true,
          });
        }
      }
    }

    // Nested workflows — Parallel branches, Map iterator/processor. Each
    // nested state becomes a child of the current state (compound parent).
    if (type === "Parallel" && Array.isArray(state.Branches)) {
      for (const branch of state.Branches) {
        parseWorkflow(branch, nodeId, nodes, edges);
      }
    }
    if (type === "Map") {
      const iterator = state.ItemProcessor ?? state.Iterator;
      if (iterator) {
        parseWorkflow(iterator, nodeId, nodes, edges);
      }
    }
  }
}

/**
 * Produce a short human-readable label for a Choice branch. Handles the
 * common shape `{Variable, <Op>: value}` (StringEquals, NumericLessThan, …);
 * falls back to `choice N` for And/Or/Not compounds or exotic shapes.
 */
function choiceLabel(choice: Record<string, unknown>, index: number): string {
  const variable = typeof choice.Variable === "string" ? choice.Variable : undefined;
  if (variable) {
    for (const key of Object.keys(choice)) {
      if (key === "Variable" || key === "Next" || key === "Comment") continue;
      const value = choice[key];
      const opSymbol = COMPARISON_SYMBOLS[key];
      if (opSymbol) {
        return `${shortVar(variable)} ${opSymbol} ${shortVal(value)}`;
      }
      // Unknown but present op — just show its name.
      return `${shortVar(variable)} ${key}`;
    }
  }
  return `choice ${index + 1}`;
}

const COMPARISON_SYMBOLS: Record<string, string> = {
  StringEquals: "=",
  StringLessThan: "<",
  StringGreaterThan: ">",
  StringLessThanEquals: "≤",
  StringGreaterThanEquals: "≥",
  NumericEquals: "=",
  NumericLessThan: "<",
  NumericGreaterThan: ">",
  NumericLessThanEquals: "≤",
  NumericGreaterThanEquals: "≥",
  BooleanEquals: "=",
  IsPresent: "isPresent",
  IsNull: "isNull",
  IsString: "isString",
  IsNumeric: "isNumeric",
};

function shortVar(v: string): string {
  // "$.foo.bar" → "foo.bar" for a lighter label.
  return v.startsWith("$.") ? v.slice(2) : v;
}
function shortVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.length > 20 ? s.slice(0, 17) + "…" : s;
}
