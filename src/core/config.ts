import * as vscode from "vscode";
import { GLOBAL_REGION, type CloudViewConfiguration } from "./contracts";
import { Lambda } from "@aws-sdk/client-lambda";

/** VS Code configuration section key for all Cloud View settings. */
export const CLOUD_VIEW_CONFIGURATION_SECTION = "cloudView";

/**
 * Reads the current Cloud View configuration from VS Code workspace settings.
 *
 * Always prepends the special `"global"` region so globally-scoped resources
 * (IAM, S3 bucket listings) are always discovered regardless of the user's
 * configured region list.
 *
 * @returns A fully-populated {@link CloudViewConfiguration} object with
 *   defaults applied for any settings the user has not explicitly configured.
 */
export function readCloudViewConfiguration(): CloudViewConfiguration {
  const config = vscode.workspace.getConfiguration(CLOUD_VIEW_CONFIGURATION_SECTION);
  const configuredRegions = config.get<string[]>("aws.regions", ["us-east-1", "us-west-2"]);
  const regions = Array.from(new Set([GLOBAL_REGION, ...configuredRegions.filter(Boolean)]));

  return {
    regions,
    defaultTtlSeconds: config.get<number>("cache.defaultTtlSeconds", 300),
    globalConcurrency: config.get<number>("scheduler.globalConcurrency", 8),
    serviceConcurrency: config.get<Record<string, number>>("scheduler.serviceConcurrency", {
      ec2: 4,
      lambda: 4,
      s3: 2,
      vpc: 2
    }),
    defaultGraphExpandDepth: config.get<number>("graph.defaultExpandDepth", 1)
  };
}
