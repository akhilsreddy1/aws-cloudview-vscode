import * as vscode from "vscode";
import type { Logger } from "./contracts";

/**
 * {@link Logger} implementation that writes structured log lines to a VS Code
 * output channel. Each message is prefixed with a severity tag:
 * `[INFO]`, `[WARN]`, or `[ERROR]`.
 *
 * For errors, the original `Error` name, message, and stack trace are
 * appended on separate lines to aid debugging.
 */
export class OutputChannelLogger implements Logger {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public info(message: string): void {
    this.output.appendLine(`[INFO] ${message}`);
  }

  public warn(message: string): void {
    this.output.appendLine(`[WARN] ${message}`);
  }

  public error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error ?? "");
    this.output.appendLine(`[ERROR] ${message}${detail ? `\n${detail}` : ""}`);
  }
}
