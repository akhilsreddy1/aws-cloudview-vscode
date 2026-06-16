import type { Logger } from "./contracts";

/**
 * Default upper bound on how many AWS API pages a single discovery run
 * will walk before giving up. Chosen so that a pathological org account
 * (e.g. 50k Lambda functions, 100k S3 objects) can't pin the event loop
 * or balloon memory indefinitely — we'd rather show a truncated list and
 * a warning than freeze the refresh.
 *
 **/
export const MAX_PAGES_DEFAULT = 75;

/**
 * Minimal shape we need from a cancellation token. Declared locally so
 * contracts.ts can stay free of the `vscode` import — `vscode.CancellationToken`
 * is structurally compatible.
 */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

/**
  * Helper to determine whether we should stop paginating through AWS API results.
  * Checks if a cancellation has been requested or if we've reached a configurable page limit.
  *
  * @param opts - Options for pagination control, including current page count, next token presence, and logging.
  * @returns `true` if pagination should stop, `false` otherwise.
 * ```
 */
export function shouldStopPagination(opts: {
  pages: number;
  nextToken: string | undefined;
  label: string;
  logger?: Logger;
  maxPages?: number;
  cancellation?: CancellationLike;
}): boolean {
  if (opts.cancellation?.isCancellationRequested) {
    return true;
  }
  if (!opts.nextToken) {
    return false;
  }
  const cap = opts.maxPages ?? MAX_PAGES_DEFAULT;
  if (opts.pages >= cap) {
    opts.logger?.warn(
      `Pagination cap (${cap}) reached for ${opts.label}; remaining pages skipped. ` +
      `Consider narrowing the scope or raising the cap if this is expected.`,
    );
    return true;
  }
  return false;
}
