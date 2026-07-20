# Changelog

All notable changes to CloudView will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
adhere to [SemVer](https://semver.org/).

## [0.0.28] - 2026-07-19

### Added

- **Kinesis Data Streams — new service.** 
- **Step Functions — visual graph based on execution history.** 
- **API Gateway  — TestInvokeMethod panel for REST routes.**

## [0.0.27] - 2026-07-08

### Added

- **Go to resource** — a global fuzzy-search palette over the whole cached resource set. `Cmd+Alt+G` / `Ctrl+Alt+G` (also under `CloudView: Go to resource…`) opens a quick pick listing every resource across all selected accounts. Type name, ARN, region, or `tag key=value` to filter. Selecting one opens the correct service dashboard, auto-switches to the tab containing the resource, opens the drawer on it, and scrolls it into view — one keystroke from anywhere to any resource. Pure local SQLite query; no AWS round-trip.
- **EC2 — Terminate instance action.** 🗑 Terminate available in the drawer for any non-terminated instance. Two-step gate: modal warning that spells out EBS volumes, EIPs, and any active termination-protection status, then a text input requiring the exact instance ID to proceed. `TerminateInstancesCommand` fires only if both gates pass.
- **S3 — path search + navigation.** New indigo-tinted search bar in the S3 browser header. Paste `s3://bucket/prefix/…`, `bucket/key`, or a bare prefix and jump directly there; every intermediate ancestor is auto-loaded and expanded so the tree opens from root down to the target. Cross-bucket paths are politely rejected. The upload button then defaults to the pasted prefix.
- **S3 — object delete.** 🗑 button beside the download button on each object row. Versioning-aware confirmation: on versioned buckets a single-modal soft-delete (creates a delete-marker); on unversioned buckets an additional type-the-filename gate before the permanent delete.

## [0.0.26] - 2026-06-14

### Added

- **Hierarchy panels: unified visual hierarchy.** 

## [0.0.25] - 2026-06-03

### Added

- **CloudFormation: stack dependencies drilldown.** 🔗 Dependencies button on stack rows opens a panel showing **Exports** this stack publishes (with consumer-stack pills), **Imports** this stack consumes (parsed from `Fn::ImportValue` in the original template), and **Nested-stack chain** (parent + children). All consumer/producer pills deep-link into the graph view.
- **EC2: SSM Session button.** 🔌 SSM Session on running instance rows opens a VS Code terminal and runs `aws ssm start-session --target … --profile … --region …`. Hidden for non-running instances.
- **ECS: exec into a running task.** 🔌 Exec button on RUNNING task rows opens a terminal and runs `aws ecs execute-command … --interactive --command "/bin/sh"`. Multi-container tasks show a quick-pick; warns if the cached `enableExecuteCommand` flag is false before continuing.

### Changed

- **Persistence switched from `better-sqlite3` to Node's built-in `node:sqlite`.** No more native prebuilds, no more per-Electron ABI matrix, no more per-platform `.vsix` artifacts. One universal build now runs on every OS / architecture VS Code itself supports.
  - **Requires VS Code ≥ 1.101** (Electron 35+ / Node 22.13+), where `node:sqlite` is available flagless. Older VS Code installs continue to be served 0.0.24 via the Marketplace's `engines.vscode` resolution.
  - Drops `better-sqlite3` + `@types/better-sqlite3` + `prebuild-install` + `node-gyp` + the `rebuild:*` / `package:*-targets` / `publish:all-targets` scripts. The publish flow is now just `npm run package` → one `.vsix`.
  - Local persistence layout is unchanged — existing `cloud-view.sqlite` files open as-is.

## [0.0.24] - 2026-05-30

### Added

- **Glue: crawlers + workflows + triggers** 
- **Step Functions: Retry from history.** 
- **Download athena query results.** 

## [0.0.23] - 2026-05-23

### Added

- **Database hierarchy drilldown.** 
- **ECS hierarchy drilldown.** 
- **Systems Manager:** the panel now uses the shared dashboard header (service
  icon + title + profile · account · region subtitle) for visual consistency
  with the other service views.

## [0.0.22] - 2026-05-21

### Added

- **AWS Glue support.** New service in the sidebar surfacing **ETL jobs**.
- **Load balancer hierarchy drilldown.** New panel (🔀 Hierarchy button on
  load balancer rows in the EC2 dashboard, plus a drawer action)
- **Athena:** picking a new table in the Tables dropdown now resets the
  query editor to a fresh `SELECT * … LIMIT 100` for that table (was:
  inserting the reference at the cursor).
- **RDS dashboard:** `Engine` is now the 2nd column (after Name).
- **CloudFormation dashboard:** the `Actions` column now sits right after
  `Events` (Stack Name · Template · Events · Actions · Status · …).
- **S3 object preview + download.** The S3 browser now lists the first 10
  objects at each prefix (newest-first) alongside the folder navigation,
  each with a **↓ Download** button

## [0.0.19] - 2026-05-16

### Added

- **Invoke integration endpoints from the API Gateway Routes panel.**
- **Cloudformation template viewer.** New webview for rendering CloudFormation
  templates from local files or S3 objects. Entry points:
  - Command: `CloudView: Open CloudFormation Template`
  - Right-click any S3 object in the S3 Explorer and select "View as
    CloudFormation Template" (only shows if the object has a `.yaml`, `.yml`,
    or `.json` extension).
- **CloudWatch Logs Insights query panel.** New webview for running CWLI
  queries against multiple log groups. Entry points:


## [0.0.15] - 2026-05-04

## [0.0.14] - 2026-05-04

### Added

- **`cloudView.storage.path` setting.** Override the directory where the
  local SQLite cache lives. Useful on corporate machines where the default
  VS Code globalStorage path is read-only, AV-quarantined, or conflicts
  with roaming-profile sync. Path may use `~` for the home directory.
  On every activation we probe the override (mkdir + tiny write test); if
  it fails we log a warning and fall back to the default location instead
  of crashing extension startup.

### Fixed

- **IAM assume-role profiles now resolve.** Profiles using `role_arn` +
  `source_profile` (or `web_identity_token_file` + `role_arn`) in
  `~/.aws/config` were silently failing with the generic


## [0.0.9] - 2026-04-29

### Added

- **Athena Query Runner.** New webview (`CloudView: Open Athena Query

## [0.0.8] - 2026-04-28

### Added

- **Cancellable global refresh with live progress.** The "Refreshing Cloud
  View resources" notification now shows `[N / total] <service> · <region>`
  as it walks selected profiles, and the **Cancel** button on the
  notification stops scheduling new service-scope runs so you can abort a
  large refresh without waiting for it to finish. Partial results stay in
  the local cache.
- `RefreshOptions.onProgress` callback on `DiscoveryCoordinator` so other
  callers can report fine-grained progress; `RefreshProgressEvent` exposes
  `{ completed, total, current: { profileName, accountId, region, service } }`.
- **Configurable global-refresh timeout.** New
  `cloudView.refresh.timeoutSeconds` setting (default `0` = disabled). When
  set, refresh aborts via the existing cancel path once the wall clock
  elapses; partial results stay in the cache and the next refresh
  reconciles. Useful as a defensive ceiling for very large orgs.

## [0.0.7] - 2026-04-25

- Added new web views and support for multi account/region

## [0.0.1] - 2026-04-20

Initial publishing baseline. See README for the full feature list.
