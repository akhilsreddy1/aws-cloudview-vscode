import { vi } from 'vitest';

export const EventEmitter = vi.fn().mockImplementation(() => ({
  event: vi.fn(),
  fire: vi.fn(),
  dispose: vi.fn(),
}));

export const window = {
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  withProgress: vi.fn(),
  createStatusBarItem: vi.fn(() => ({
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    text: '',
    tooltip: '',
    command: '',
  })),
  registerTreeDataProvider: vi.fn(),
  createWebviewPanel: vi.fn(() => ({
    webview: { html: '', postMessage: vi.fn(), onDidReceiveMessage: vi.fn() },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
    dispose: vi.fn(),
  })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  })),
  onDidChangeConfiguration: vi.fn(),
  openTextDocument: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  iconPath: unknown;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  command?: unknown;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
  SourceControl = 1,
  Window = 10,
}

export enum ViewColumn {
  One = 1,
  Two = 2,
}

export const Uri = {
  joinPath: vi.fn((..._parts: unknown[]) => ({ toString: () => 'mock-uri' })),
};
