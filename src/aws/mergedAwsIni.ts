import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ParsedIniData } from "@smithy/types";
import { externalDataInterceptor, getHomeDir, parseKnownFiles } from "@smithy/shared-ini-file-loader";

export interface MergedAwsIniInit {
  filepath?: string;
  configFilepath?: string;
  ignoreCache?: boolean;
}

/** Strip UTF-8 BOM so smithy `parseIni` recognises the first `[section]` line (seen with Windows Notepad BOM). */
function stripLeadingUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Resolves config/credentials paths the same way as `loadSharedConfigFiles` in Smithy.
 */
function resolveAwsIniPaths(init: MergedAwsIniInit = {}): { configPath: string; credentialsPath: string } {
  const homeDir = getHomeDir();
  const relativeHomeDirPrefix = "~/";
  const filepath =
    init.filepath ?? process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(homeDir, ".aws", "credentials");
  const configFilepath = init.configFilepath ?? process.env.AWS_CONFIG_FILE ?? path.join(homeDir, ".aws", "config");

  let resolvedFilepath = filepath;
  if (filepath.startsWith(relativeHomeDirPrefix)) {
    resolvedFilepath = path.join(homeDir, filepath.slice(2));
  }
  let resolvedConfigFilepath = configFilepath;
  if (configFilepath.startsWith(relativeHomeDirPrefix)) {
    resolvedConfigFilepath = path.join(homeDir, configFilepath.slice(2));
  }

  return { configPath: resolvedConfigFilepath, credentialsPath: resolvedFilepath };
}

async function interceptBomStrippedContents(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    try {
      let raw = await fs.readFile(p, "utf8");
      raw = stripLeadingUtf8Bom(raw);
      externalDataInterceptor.interceptFile(p, raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Merges `~/.aws/config` and `~/.aws/credentials` like `fromIni` / `parseKnownFiles`, but fixes a leading UTF-8 BOM
 * so profile sections are not dropped (common on Windows).
 */
export async function parseMergedAwsIniLikeSdk(init: MergedAwsIniInit = {}): Promise<ParsedIniData> {
  const resolved = resolveAwsIniPaths(init);
  await interceptBomStrippedContents([resolved.configPath, resolved.credentialsPath]);
  return parseKnownFiles({
    filepath: resolved.credentialsPath,
    configFilepath: resolved.configPath,
    ignoreCache: init.ignoreCache,
  });
}
