import type { HistoryEvent } from "@aws-sdk/client-sfn";

/**
 * Compute a per-state overlay from a Step Functions execution history.
 *
 * We walk the events in order, tagging each state as it's entered/exited
 * and pairing consecutive exit→enter pairs into the ordered list of edges
 * the execution actually took. Failure details from `TaskFailed` /
 * `ExecutionFailed` events attach to the state that failed.
 *
 * Ambiguity note: history events carry a state's *name*, not a fully
 * qualified id, so states with identical names inside different Parallel
 * branches can't be distinguished from history alone. Callers apply the
 * outcome to every node whose `.name` matches — visually consistent, if
 * slightly noisy on machines that reuse state names across branches.
 */

export interface StateOutcome {
  entered?: number;
  exited?: number;
  outcome: "succeeded" | "failed" | "timed-out" | "aborted" | "running";
  input?: string;
  output?: string;
  error?: string;
  cause?: string;
}

export interface ExecutionOverlay {
  /** Outcome per state name (unqualified). */
  perState: Record<string, StateOutcome>;
  /** Edges the execution actually took, in order. `from` / `to` are bare state names. */
  takenEdges: Array<{ from: string; to: string }>;
  /** Terminal status of the execution as a whole. */
  finalStatus: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "RUNNING";
}

/**
 * Event types StepFunctions emits for state lifecycle. We only care about
 * whether the event is an "entered" or "exited" and the state's name +
 * timestamp — the specific type (TaskStateEntered vs ChoiceStateEntered)
 * doesn't otherwise matter for the overlay.
 */
const ENTERED_SUFFIX = "StateEntered";
const EXITED_SUFFIX = "StateExited";

export function overlayFromHistory(events: HistoryEvent[]): ExecutionOverlay {
  const perState: Record<string, StateOutcome> = {};
  const takenEdges: Array<{ from: string; to: string }> = [];
  let finalStatus: ExecutionOverlay["finalStatus"] = "RUNNING";

  let lastExited: string | undefined;

  for (const ev of events) {
    const type = ev.type ?? "";
    const ts = ev.timestamp ? ev.timestamp.getTime() : undefined;

    if (type.endsWith(ENTERED_SUFFIX)) {
      const name = ev.stateEnteredEventDetails?.name;
      if (!name) continue;
      const prior = perState[name];
      perState[name] = {
        ...(prior ?? { outcome: "running" }),
        entered: ts ?? prior?.entered,
        input: ev.stateEnteredEventDetails?.input ?? prior?.input,
      };
      if (lastExited && lastExited !== name) {
        takenEdges.push({ from: lastExited, to: name });
      }
      lastExited = undefined;
    } else if (type.endsWith(EXITED_SUFFIX)) {
      const name = ev.stateExitedEventDetails?.name;
      if (!name) continue;
      const prior = perState[name] ?? { outcome: "running" as const };
      perState[name] = {
        ...prior,
        exited: ts ?? prior.exited,
        output: ev.stateExitedEventDetails?.output ?? prior.output,
        // If we hadn't already downgraded via a failure event, mark succeeded.
        outcome: prior.outcome === "running" ? "succeeded" : prior.outcome,
      };
      lastExited = name;
    } else if (
      type === "TaskFailed" ||
      type === "TaskTimedOut" ||
      type === "LambdaFunctionFailed" ||
      type === "LambdaFunctionTimedOut" ||
      type === "ActivityFailed" ||
      type === "ActivityTimedOut"
    ) {
      // Failure attaches to the current in-flight state (the most recently
      // entered one that hasn't exited yet). We find it by scanning back
      // through perState for something still marked as running.
      const failingName = findLastRunning(perState);
      if (failingName) {
        const details =
          ev.taskFailedEventDetails ??
          ev.lambdaFunctionFailedEventDetails ??
          ev.lambdaFunctionTimedOutEventDetails ??
          ev.activityFailedEventDetails ??
          ev.activityTimedOutEventDetails;
        perState[failingName] = {
          ...perState[failingName],
          outcome: type.endsWith("TimedOut") ? "timed-out" : "failed",
          error: details?.error,
          cause: details?.cause,
        };
      }
    } else if (type === "ExecutionSucceeded") {
      finalStatus = "SUCCEEDED";
    } else if (type === "ExecutionFailed") {
      finalStatus = "FAILED";
      const details = ev.executionFailedEventDetails;
      const failingName = findLastRunning(perState);
      if (failingName && details) {
        perState[failingName] = {
          ...perState[failingName],
          outcome: "failed",
          error: details.error ?? perState[failingName].error,
          cause: details.cause ?? perState[failingName].cause,
        };
      }
    } else if (type === "ExecutionTimedOut") {
      finalStatus = "TIMED_OUT";
      const failingName = findLastRunning(perState);
      if (failingName) {
        perState[failingName] = { ...perState[failingName], outcome: "timed-out" };
      }
    } else if (type === "ExecutionAborted") {
      finalStatus = "ABORTED";
      const failingName = findLastRunning(perState);
      if (failingName) {
        perState[failingName] = { ...perState[failingName], outcome: "aborted" };
      }
    }
  }

  return { perState, takenEdges, finalStatus };
}

function findLastRunning(perState: Record<string, StateOutcome>): string | undefined {
  // Iterate keys in insertion order (which mirrors event order). The last
  // still-running state is the current in-flight one.
  let last: string | undefined;
  for (const [name, outcome] of Object.entries(perState)) {
    if (outcome.outcome === "running") last = name;
  }
  return last;
}
