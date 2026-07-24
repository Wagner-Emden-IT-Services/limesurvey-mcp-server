# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `import_data_path` parameter for `import_survey`, `import_group`, and
  `import_question`: the server reads and base64-encodes a local file from
  `LIMESURVEY_IMPORT_DIR` (falling back to `LIMESURVEY_EXPORT_DIR`), so a
  survey, group, or question file of any size can be imported in a single
  tool call instead of an inline base64 payload. New `LIMESURVEY_IMPORT_DIR`
  and `LIMESURVEY_MAX_IMPORT_BYTES` (default 50 MiB) environment variables,
  and dedicated `IMPORT_*` error codes with `recovery` guidance.
- `get_instance_info` workflow tool: reports read-only mode, the
  experimental-methods flag, configured export/import/theme directories, and
  best-effort LimeSurvey version/database version/default theme (each
  `get_site_settings` call degrades independently to `null` with a
  `permission_note` when the service account is not a superadmin).
- `list_installed_themes` workflow tool: best-effort reports the current
  default theme and always includes the documented LimeSurvey admin-UI
  fallback, since RemoteControl2 has no official method to enumerate
  installed themes.
- `export_survey` workflow tool (experimental, gated behind
  `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS`, same precedent as
  `list_response_exports`): attempts to export a survey's structure and write
  it inside `LIMESURVEY_EXPORT_DIR`, returning a path instead of base64.
  `export_survey` is not part of the officially documented LimeSurvey
  RemoteControl2 API (verified 2026-07-24 against api.limesurvey.org and the
  LimeSurvey source), so this only works against an instance with a custom
  plugin providing an equivalent method; it otherwise always fails with a
  structured `EXPORT_UNSUPPORTED` error recommending property-based
  verification (`list_groups`, `list_questions`, `get_survey_properties`,
  `get_group_properties`, `get_question_properties`) instead of round-trip
  diffing.

### Changed

- Document that `import_survey` returns the survey ID LimeSurvey actually
  assigned: it keeps the ID embedded in the file when free, honors
  `destination_survey_id` when provided, and silently assigns a random
  6-digit ID on collision instead of failing.
- The `LIMESURVEY_EXPORT_DIR`/`LIMESURVEY_THEME_DIR` "not configured" errors
  now mention that changing the environment requires a full MCP client
  restart; reconnecting alone does not reload environment variables.

### Fixed

- Workflow-tool errors (`workflow-tools.ts`) now include the `LimeSurveyError`
  `details` object (for example a `recovery` hint) in their structured
  output, matching the official-tool error path in `server.ts`.

## [1.2.3] - 2026-07-23

### Changed

- Re-publish to npm via OIDC Trusted Publishing so the release carries build
  provenance and is attributed to the GitHub Actions publisher. No functional
  or API changes.

## [1.2.2] - 2026-07-23

### Added

- Public npm distribution documentation for Codex CLI, MCP JSON clients,
  global npm, source, and Docker installations.
- Installation verification, update, removal, and troubleshooting guidance.

### Changed

- Upgrade to Zod 4, TypeScript 7, Node.js 26 type definitions, and current
  GitHub Actions majors.
- Harden the npm Trusted Publishing workflow with release-tag validation and
  serialized publishes.

### Fixed

- Adapt recursive JSON and record schemas to Zod 4 while preserving MCP input
  validation for participant filters and workflow tools.

## [1.2.1] - 2026-07-23

### Added

- Guarded opt-in live integration runner covering all 68 MCP tools with
  prefixed test records, automatic cleanup, and explicit CPD cleanup reporting.
- Live integration testing documentation.

### Fixed

- Detect LimeSurvey API failures that contain a failure `status` or non-empty
  `errors` object but omit `error_code`.

## [1.2.0] - 2026-07-22

### Added

- Responsive LimeSurvey 7/6 survey theme generator based on the official
  `fruity_twentythree` Bootstrap 5 theme.
- Theme ZIP validation for manifests, compatibility, archive paths, asset
  signatures, size limits, licensing, responsive CSS, and risky external CSS.
- Version-aware theme installation, acceptance, rollback, and community
  publication guidance.
- Workflow for assigning an installed theme to a survey.
- Public repository metadata, security policy, contribution guide, Dependabot,
  and expanded CI for Node.js 20, 22, and 24.

## [1.1.0] - 2026-07-21

### Added

- Server-enforced read-only mode and explicit confirmations for destructive,
  email, activation, and overwrite operations.
- Eight workflow tools for survey discovery, languages, participants, export
  format discovery, and secure file exports.
- Authenticated MCP Streamable HTTP transport, Docker/Compose, healthcheck, and CI.

## [1.0.0] - 2026-07-21

### Added

- Complete coverage of all 56 documented LimeSurvey RemoteControl 2 methods.
- JSON-RPC 1.0 client with session reuse, retry, timeouts, structured MCP output,
  Zod validation, annotations, stdio transport, and mocked endpoint tests.

[1.2.2]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/releases/tag/v1.0.0
