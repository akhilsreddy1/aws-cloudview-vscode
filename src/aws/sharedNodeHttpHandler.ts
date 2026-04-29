import type { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Logger } from "../core/contracts";
import { buildDefaultRequestHandler, buildProxyRequestHandler, resolveProxyConfig } from "./proxyConfig";

let cached: NodeHttpHandler | undefined;

/**
 * One Node HTTP handler for all AWS SDK usage (factory clients + ad-hoc clients
 * like `SessionManager`'s bootstrap STS) so proxy/timeouts are consistent.
 */
export function getSharedNodeHttpHandler(logger?: Logger): NodeHttpHandler {
  if (cached === undefined) {
    const proxy = resolveProxyConfig(logger);
    cached = proxy ? buildProxyRequestHandler(proxy) : buildDefaultRequestHandler();
  }
  return cached;
}

/** Clears the cached handler; call when proxy settings change. */
export function resetSharedNodeHttpHandler(): void {
  cached = undefined;
}
