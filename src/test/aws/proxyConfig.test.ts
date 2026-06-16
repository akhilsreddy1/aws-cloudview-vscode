import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { resolveProxyConfig, proxyConfigAffectedBy } from "../../aws/proxyConfig";

/**
 * Fakes `vscode.workspace.getConfiguration(section)` by returning a fresh
 * object whose `.get(key, default)` reads from the per-section settings map.
 */
function stubVscodeConfig(settings: Record<string, Record<string, unknown>>): void {
  (vscode.workspace.getConfiguration as unknown as vi.Mock).mockImplementation((section: string) => ({
    get: (key: string, defaultVal: unknown) => {
      const fromSection = settings[section]?.[key];
      return fromSection !== undefined ? fromSection : defaultVal;
    },
  }));
}

describe("resolveProxyConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    stubVscodeConfig({ cloudView: {}, http: {} });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("returns undefined when no proxy is configured anywhere", () => {
    expect(resolveProxyConfig()).toBeUndefined();
  });

  it("picks up HTTPS_PROXY from the environment", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const cfg = resolveProxyConfig();
    expect(cfg?.httpsProxyUrl).toBe("http://env-proxy:8080");
    expect(cfg?.strictSsl).toBe(true); // default
  });

  it("accepts lower-case env vars (https_proxy)", () => {
    process.env.https_proxy = "http://lower-env:8080";
    const cfg = resolveProxyConfig();
    expect(cfg?.httpsProxyUrl).toBe("http://lower-env:8080");
  });

  it("VS Code http.proxy overrides env vars", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    stubVscodeConfig({ cloudView: {}, http: { proxy: "http://vscode-proxy:3128" } });
    const cfg = resolveProxyConfig();
    expect(cfg?.httpsProxyUrl).toBe("http://vscode-proxy:3128");
  });

  it("cloudView.proxy.url overrides both VS Code and env settings", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    stubVscodeConfig({
      cloudView: { "proxy.url": "http://cv-proxy:9000" },
      http: { proxy: "http://vscode-proxy:3128" },
    });
    const cfg = resolveProxyConfig();
    expect(cfg?.httpsProxyUrl).toBe("http://cv-proxy:9000");
  });

  it("honours http.proxyStrictSSL=false", () => {
    stubVscodeConfig({ cloudView: {}, http: { proxy: "http://p:8080", proxyStrictSSL: false } });
    const cfg = resolveProxyConfig();
    expect(cfg?.strictSsl).toBe(false);
  });

  it("merges NO_PROXY env + http.noProxy setting", () => {
    process.env.NO_PROXY = "localhost,169.254.169.254";
    stubVscodeConfig({
      cloudView: {},
      http: { proxy: "http://p:8080", noProxy: ["internal.corp"] },
    });
    const cfg = resolveProxyConfig();
    expect(cfg?.noProxy).toEqual(["internal.corp", "localhost", "169.254.169.254"]);
  });

  it("trims whitespace in cloudView.proxy.url (treats blank as unset)", () => {
    stubVscodeConfig({ cloudView: { "proxy.url": "   " }, http: {} });
    expect(resolveProxyConfig()).toBeUndefined();
  });
});

describe("proxyConfigAffectedBy", () => {
  it("returns true for any proxy-related key", () => {
    const evt = {
      affectsConfiguration: vi.fn((key: string) => key === "http.proxy"),
    } as unknown as vscode.ConfigurationChangeEvent;
    expect(proxyConfigAffectedBy(evt)).toBe(true);
  });

  it("returns false for unrelated changes", () => {
    const evt = {
      affectsConfiguration: vi.fn(() => false),
    } as unknown as vscode.ConfigurationChangeEvent;
    expect(proxyConfigAffectedBy(evt)).toBe(false);
  });
});
