import * as vscode from "vscode";

/**
 * Broad categories of AWS API errors. Used to decide how to surface a failure
 * to the user (silent, warning, actionable error message, etc.).
 */
export enum ErrorCategory {
  Credentials = "credentials",
  Permissions = "permissions",
  Throttling = "throttling",
  Network = "network",
  NotFound = "not_found",
  Validation = "validation",
  ServiceError = "service_error",
  Unknown = "unknown",
}

/**
 * A normalized error representation produced by {@link classifyError}.
 * `retryable` indicates whether the operation should be automatically
 * retried (e.g. throttling or credential expiry) vs. reported and abandoned.
 */
export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  originalError: unknown;
  service?: string;
  action?: string;
}

const CREDENTIAL_ERROR_CODES = new Set([
  "ExpiredTokenException",
  "ExpiredToken",
  "InvalidIdentityToken",
  "InvalidClientTokenId",
  "AuthFailure",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "CredentialsError",
]);

const THROTTLE_ERROR_CODES = new Set([
  "Throttling",
  "ThrottlingException",
  "ThrottledException",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "ProvisionedThroughputExceededException",
  "BandwidthLimitExceeded",
  "SlowDown",
  "RequestThrottled",
  "EC2ThrottledException",
]);

const PERMISSION_ERROR_CODES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "UnauthorizedAccess",
  "Forbidden",
  "InsufficientPrivilegesException",
]);

const NOT_FOUND_ERROR_CODES = new Set([
  "ResourceNotFoundException",
  "NotFoundException",
  "NoSuchEntity",
  "NoSuchBucket",
  "NoSuchKey",
  "DBInstanceNotFound",
  "ClusterNotFoundFault",
]);

/**
 * Inspects an unknown thrown value and maps it to a {@link ClassifiedError}
 * based on well-known AWS SDK error codes. Non-`Error` values are wrapped
 * as `ErrorCategory.Unknown`.
 *
 * @param err - The caught value (usually an `Error` from an AWS SDK call).
 * @param context - Optional service/action labels included in the result for
 *   richer error messages.
 */
export function classifyError(err: unknown, context?: { service?: string; action?: string }): ClassifiedError {
  const base = { originalError: err, service: context?.service, action: context?.action };

  if (!(err instanceof Error)) {
    return { ...base, category: ErrorCategory.Unknown, message: String(err), retryable: false };
  }

  const code =
    (err as { name?: string; code?: string; Code?: string }).name ??
    (err as { code?: string }).code ??
    (err as { Code?: string }).Code ??
    "";

  if (CREDENTIAL_ERROR_CODES.has(code)) {
    return { ...base, category: ErrorCategory.Credentials, message: `Authentication failed: ${err.message}`, retryable: true };
  }
  if (THROTTLE_ERROR_CODES.has(code)) {
    return { ...base, category: ErrorCategory.Throttling, message: `Rate limited: ${err.message}`, retryable: true };
  }
  if (PERMISSION_ERROR_CODES.has(code)) {
    return { ...base, category: ErrorCategory.Permissions, message: `Permission denied: ${err.message}`, retryable: false };
  }
  if (NOT_FOUND_ERROR_CODES.has(code)) {
    return { ...base, category: ErrorCategory.NotFound, message: err.message, retryable: false };
  }

  if (
    err.message.includes("ENOTFOUND") ||
    err.message.includes("ECONNREFUSED") ||
    err.message.includes("ETIMEDOUT") ||
    err.message.includes("NetworkError")
  ) {
    return { ...base, category: ErrorCategory.Network, message: `Network error: ${err.message}`, retryable: true };
  }

  return { ...base, category: ErrorCategory.Unknown, message: err.message, retryable: false };
}

/**
 * Classifies an error and displays a user-facing VS Code notification.
 *
 * - Credential errors prompt the user to select a profile.
 * - Permission errors show a warning with IAM guidance.
 * - Throttling errors show a self-healing advisory.
 * - Network errors prompt connectivity checks.
 * - All other errors display the raw message.
 *
 * Pass `context.silent = true` to suppress the notification (useful in
 * background loops where only logging is needed).
 */
export async function showClassifiedError(
  err: unknown,
  context?: { service?: string; action?: string; silent?: boolean }
): Promise<void> {
  const classified = classifyError(err, context);

  if (context?.silent) {
    return;
  }

  switch (classified.category) {
    case ErrorCategory.Credentials: {
      const action = await vscode.window.showErrorMessage(classified.message, "Select Profile");
      if (action === "Select Profile") {
        await vscode.commands.executeCommand("cloudView.selectProfile");
      }
      break;
    }
    case ErrorCategory.Permissions: {
      const svc = classified.service ? ` for ${classified.service}` : "";
      void vscode.window.showWarningMessage(`Insufficient IAM permissions${svc}. Check your policy allows this action.`);
      break;
    }
    case ErrorCategory.Throttling:
      void vscode.window.showWarningMessage("AWS API rate limit reached. The request will be retried automatically.");
      break;
    case ErrorCategory.Network:
      void vscode.window.showErrorMessage("Network error — check your connection and VPN status.");
      break;
    case ErrorCategory.NotFound:
      void vscode.window.showInformationMessage(classified.message);
      break;
    default: {
      const label = classified.service ? `[${classified.service}] ` : "";
      void vscode.window.showErrorMessage(`${label}${classified.message}`);
    }
  }
}
