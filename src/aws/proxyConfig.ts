import * as vscode from "vscode";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import type { Logger } from "../core/contracts";

const CONNECTION_TIMEOUT_MS = 10_000;

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Resolved proxy settings for a single factory instance. `undefined` means
 * "no proxy configured" — callers should pass `undefined` to AWS SDK clients
 * so the SDK uses its default HTTP agent.
 */
export interface ProxyConfig {
  /** Proxy URL used for HTTPS targets (AWS API calls). */
  httpsProxyUrl?: string;
  /** Proxy URL used for plain HTTP targets (rare — mostly used by SSO/IMDS flows). */
  httpProxyUrl?: string;
  /** Hostnames the proxy should be bypassed for (from NO_PROXY or http.noProxy). */
  noProxy: string[];
  /** `false` when `http.proxyStrictSSL` is explicitly disabled — only relevant for MITM'ing corp proxies. */
  strictSsl: boolean;
}

/**
 * Resolves a {@link ProxyConfig} from (in order of precedence):
 *
 * 1. `cloudView.proxy.url` — CloudView-specific override.
 * 2. VS Code's built-in `http.proxy` / `http.proxyStrictSSL` / `http.noProxy` settings.
 * 3. `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` environment variables (lower-case forms also respected).
 *
 * Returns `undefined` if no proxy is configured anywhere — callers should
 * skip injecting a `requestHandler` in that case so the SDK uses its default.
 */
export function resolveProxyConfig(logger?: Logger): ProxyConfig | undefined {
  // 1. CloudView-specific override.
  const cvConfig = vscode.workspace.getConfiguration("cloudView");
  const cvProxy = cvConfig.get<string>("proxy.url", "").trim();

  // 2. VS Code built-in HTTP settings.
  const httpConfig = vscode.workspace.getConfiguration("http");
  const vscodeProxy = httpConfig.get<string>("proxy", "").trim();
  const strictSsl = httpConfig.get<boolean>("proxyStrictSSL", true);
  const vscodeNoProxy = httpConfig.get<string[]>("noProxy", []);

  // 3. Environment variables — tolerate either case (Unix tradition varies).
  const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const envHttp = process.env.HTTP_PROXY || process.env.http_proxy || "";
  const envNo = process.env.NO_PROXY || process.env.no_proxy || "";

  // Precedence: CloudView setting wins over VS Code setting, which wins over env vars.
  const httpsProxyUrl = cvProxy || vscodeProxy || envHttps || undefined;
  const httpProxyUrl = cvProxy || vscodeProxy || envHttp || undefined;

  if (!httpsProxyUrl && !httpProxyUrl) {
    return undefined;
  }

  const noProxy = [
    ...vscodeNoProxy,
    ...envNo.split(",").map((s) => s.trim()).filter(Boolean),
  ];

  const source = cvProxy ? "cloudView.proxy.url" : vscodeProxy ? "http.proxy" : "environment";
  logger?.info(
    `AWS clients using proxy from ${source}: ${httpsProxyUrl ?? httpProxyUrl} (strictSsl=${strictSsl}, noProxy=${noProxy.length} entries)`,
  );

  return { httpsProxyUrl, httpProxyUrl, noProxy, strictSsl };
}

/**
 * Builds a Smithy `NodeHttpHandler` wired to an HTTPS/HTTP proxy agent.
 * Always carries the connect/request timeouts so a stuck proxy can't hang
 * the extension. The returned handler should be passed as `requestHandler`
 * to every AWS SDK client constructor. 
 */
export function buildProxyRequestHandler(config: ProxyConfig): NodeHttpHandler {
  const agentOpts = { rejectUnauthorized: config.strictSsl };

  const httpsAgent = config.httpsProxyUrl
    ? new HttpsProxyAgent(config.httpsProxyUrl, agentOpts)
    : undefined;
  const httpAgent = config.httpProxyUrl
    ? new HttpProxyAgent(config.httpProxyUrl, agentOpts)
    : undefined;

  // NodeHttpHandler's typed options are a union that includes a `Provider<...>`,
  // which narrows away the plain-object shape our agents fit. Cast through
  // `any` — at runtime the handler accepts `{ httpsAgent, httpAgent }` fine.
  return new NodeHttpHandler({
    httpsAgent:httpsAgent,
    httpAgent:httpAgent,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  } as any);
}

/**
 * Builds a `NodeHttpHandler` with just the connect/request timeouts applied,
 * using the SDK's default agents. This is what every client gets when no
 * proxy is configured — without it, the SDK falls back to Node's default
 * socket behavior where a blackholed endpoint can hang for the OS-level
 * TCP timeout (~2 minutes on Linux/macOS), freezing the refresh progress
 * bar and looking like the extension has locked up.
 */
export function buildDefaultRequestHandler(): NodeHttpHandler {
  return new NodeHttpHandler({
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Returns true when any of the VS Code keys that feed into
 * {@link resolveProxyConfig} are affected by the given configuration change
 * event. Used by the extension's activation code to invalidate cached AWS
 * clients so new requests pick up the updated proxy without a restart.
 */
export function proxyConfigAffectedBy(evt: vscode.ConfigurationChangeEvent): boolean {
  return (
    evt.affectsConfiguration("cloudView.proxy.url") ||
    evt.affectsConfiguration("http.proxy") ||
    evt.affectsConfiguration("http.proxyStrictSSL") ||
    evt.affectsConfiguration("http.noProxy")
  );
}
