# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.1]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/releases/tag/v1.0.0
