/** A single instrumentation event buffered by {@link TelemetryReporter}. */
export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
  timestamp: number;
}

/**
 * In-process telemetry reporter that buffers events in memory.
 * Telemetry is disabled by default and must be explicitly enabled via
 * {@link setEnabled}. The buffer is capped at 500 events to prevent
 * unbounded memory growth; older events are dropped when the cap is reached.
 *
 * Call {@link flush} to retrieve and clear all buffered events for transmission.
 */
export class TelemetryReporter {
  private buffer: TelemetryEvent[] = [];
  private readonly maxBufferSize = 500;
  private enabled = false;

  /** Enable or disable event buffering. When disabled, all `track*` calls are no-ops. */
  public setEnabled(value: boolean): void {
    this.enabled = value;
  }

  public trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
    if (!this.enabled) {
      return;
    }

    this.buffer.push({ name, properties, measurements, timestamp: Date.now() });

    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize);
    }
  }

  public trackServiceBrowse(serviceId: string): void {
    this.trackEvent("service.browse", { serviceId });
  }

  public trackAction(action: string, serviceId: string): void {
    this.trackEvent("action.execute", { action, serviceId });
  }

  public trackError(category: string, service?: string): void {
    this.trackEvent("error", { category, service: service ?? "unknown" });
  }

  public trackLatency(operation: string, durationMs: number): void {
    this.trackEvent("latency", { operation }, { durationMs });
  }

  /** Returns all buffered events and clears the internal buffer. */
  public flush(): TelemetryEvent[] {
    const events = [...this.buffer];
    this.buffer = [];
    return events;
  }

  public dispose(): void {
    this.buffer = [];
  }
}
