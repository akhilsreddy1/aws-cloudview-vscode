import type { CloudViewConfiguration, Logger } from "../core/contracts";

/**
 * A counting semaphore with a dynamically-resolved limit. Callers `acquire()`
 * a slot before running an operation and `release()` it afterwards. The
 * `getLimit` accessor is consulted on every `acquire()` and every `release()`
 * so VS Code settings changes (e.g. `scheduler.globalConcurrency`) take
 * effect without an extension reload.
 */
class DynamicSemaphore {
  private current = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly getLimit: () => number) {}

  public async acquire(): Promise<void> {
    if (this.current < this.getLimit()) {
      this.current += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.current += 1;
        resolve();
      });
    });
  }

  public release(): void {
    this.current = Math.max(0, this.current - 1);
    if (this.current < this.getLimit() && this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }
}

const THROTTLE_ERROR_CODES = new Set([
  "Throttling",
  "ThrottlingException",
  "Throttled",
  "ThrottledException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
  "TooManyRequests",
  "SlowDown",
  "ProvisionedThroughputExceededException",
  "TransactionInProgressException",
  "PriorRequestNotComplete"
]);

const TRANSIENT_ERROR_CODES = new Set([
  "NetworkingError",
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalError",
  "InternalFailure",
  "InternalServerError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND"
]);

const RETRY_MAX_BACKOFF_MS = 10_000;

/**
 * Throttles outbound AWS API calls using two layers of concurrency control:
 *
 * 1. **Global semaphore** — caps the total number of concurrent requests
 *    across all services (configured via `scheduler.globalConcurrency`).
 *    Limit is read on every acquire/release so config changes apply live.
 * 2. **Per-service semaphores** — caps requests for a specific service
 *    (configured via `scheduler.serviceConcurrency[service]`, defaulting to
 *    half of `globalConcurrency`). These are also dynamic.
 *
 * The retry predicate covers:
 *   - AWS throttling codes (Throttling, TooManyRequestsException, …)
 *   - Transient network errors (ECONNRESET, ETIMEDOUT, EAI_AGAIN, …)
 *   - HTTP 5xx responses on `error.$metadata.httpStatusCode`
 *   - SDK v3 `error.$retryable` metadata
 *
 * Non-retryable errors (AccessDenied, ValidationException, 4xx responses
 * other than 408/429) are propagated immediately.
 */
export class AwsRequestScheduler {
  private readonly globalSemaphore: DynamicSemaphore;
  private readonly serviceSemaphores = new Map<string, DynamicSemaphore>();
  private readonly maxRetries = 5;

  public constructor(private readonly config: () => CloudViewConfiguration, private readonly logger: Logger) {
    this.globalSemaphore = new DynamicSemaphore(() => Math.max(1, this.config().globalConcurrency));
  }

  /**
   * Runs `task` under both the global and service-level semaphores.
   * Retries automatically on transient / throttling errors with jittered
   * exponential back-off.
   */
  public async run<T>(service: string, operation: string, task: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      await this.globalSemaphore.acquire();
      const serviceSemaphore = this.getServiceSemaphore(service);
      await serviceSemaphore.acquire();

      let alreadyReleased = false;
      try {
        return await task();
      } catch (error) {
        if (this.isRetryable(error) && attempt < this.maxRetries) {
          const delayMs = this.calculateDelay(attempt);
          this.logger.warn(
            `Retrying ${service}:${operation} after transient error (${attempt + 1}/${this.maxRetries}): ${this.describeError(error)}`
          );
          attempt += 1;
          // Release slots before sleeping so other tasks make progress.
          serviceSemaphore.release();
          this.globalSemaphore.release();
          alreadyReleased = true;
          await this.sleep(delayMs);
          continue;
        }

        throw error;
      } finally {
        if (!alreadyReleased) {
          serviceSemaphore.release();
          this.globalSemaphore.release();
        }
      }
    }
  }

  private getServiceSemaphore(service: string): DynamicSemaphore {
    let semaphore = this.serviceSemaphores.get(service);
    if (!semaphore) {
      const limitFn = () => {
        const cfg = this.config();
        const override = cfg.serviceConcurrency?.[service];
        if (typeof override === "number" && override > 0) {
          return override;
        }
        return Math.max(1, Math.floor(cfg.globalConcurrency / 2));
      };
      semaphore = new DynamicSemaphore(limitFn);
      this.serviceSemaphores.set(service, semaphore);
    }

    return semaphore;
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof Error) && typeof error !== "object") {
      return false;
    }
    const err = error as Error & {
      Code?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
      $retryable?: boolean | { throttling?: boolean };
    };

    const name = err.name;
    const codeA = err.Code;
    const codeB = err.code;

    if (name && THROTTLE_ERROR_CODES.has(name)) { return true; }
    if (codeA && THROTTLE_ERROR_CODES.has(codeA)) { return true; }
    if (codeB && THROTTLE_ERROR_CODES.has(codeB)) { return true; }
    if (name && TRANSIENT_ERROR_CODES.has(name)) { return true; }
    if (codeA && TRANSIENT_ERROR_CODES.has(codeA)) { return true; }
    if (codeB && TRANSIENT_ERROR_CODES.has(codeB)) { return true; }

    const status = err.$metadata?.httpStatusCode;
    if (typeof status === "number") {
      // 429 Too Many Requests and 5xx are retryable. 408 Request Timeout too.
      if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
        return true;
      }
    }

    const retryable = err.$retryable;
    if (retryable === true) { return true; }
    if (retryable && typeof retryable === "object" && retryable.throttling === true) { return true; }

    return false;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      const status = (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const suffix = typeof status === "number" ? ` [${status}]` : "";
      return `${error.name}: ${error.message}${suffix}`;
    }
    return String(error);
  }

  private calculateDelay(attempt: number): number {
    const base = Math.min(1_000 * 2 ** attempt, RETRY_MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
