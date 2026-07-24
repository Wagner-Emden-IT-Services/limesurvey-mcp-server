# LimeSurvey MCP Server

[![npm version](https://img.shields.io/npm/v/limesurvey-mcp-server.svg)](https://www.npmjs.com/package/limesurvey-mcp-server)
[![CI](https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/limesurvey-mcp-server.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

A production-oriented [Model Context Protocol](https://modelcontextprotocol.io/)
server for the [LimeSurvey RemoteControl 2 API](https://www.limesurvey.org/manual/RemoteControl_2_API).
It exposes all 56 documented RemoteControl methods plus 15 guarded workflow tools
for discovery, participants, exports, capability detection, and responsive
survey themes.

This community project is not affiliated with or endorsed by LimeSurvey GmbH.

## Features

- **Complete RemoteControl coverage:** all 56 documented JSON-RPC methods
- **71 MCP tools:** official methods plus focused workflow and theme tools
- **Modern MCP contracts:** strict Zod schemas, structured output, and annotations
- **Safe write access:** server-enforced read-only mode and explicit confirmations
- **Session management:** cached credentials, one retry after an invalid session,
  graceful release, timeouts, and sanitized errors
- **Two transports:** stdio for local clients and authenticated Streamable HTTP
- **Secure exports:** bounded base64 decoding into a dedicated directory
- **Survey theme workflow:** generate, validate, publish, and assign responsive themes
- **Deployment ready:** Docker, Compose, healthcheck, CI, and Dependabot

## Tool Catalog

| Area | Tools | Count |
|---|---|---:|
| Official RemoteControl 2 API | Sessions, settings, surveys, languages, groups, questions, participants, quotas, users, responses, files, exports | 56 |
| Workflow helpers | Survey search, language normalization, participant helpers, export format discovery, secure file exports, experimental survey-structure export, capability/instance info | 10 |
| Survey themes | Generate, validate, publication guide, assign to survey, best-effort theme listing | 5 |
| **Total** | | **71** |

Official tools are named `limesurvey_<remotecontrol_method>`. Run the MCP
Inspector to view every current schema:

```bash
npm run inspect
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer, or Docker
- A reachable LimeSurvey instance
- A dedicated LimeSurvey service account with only the required permissions
- In LimeSurvey: enable the API and select JSON-RPC under
  **Configuration > Global settings > Interfaces**

### Option A: npm

```bash
npx -y limesurvey-mcp-server@1.2.2
```

The server uses stdio by default. Supply credentials through the MCP client
configuration shown below. Pin a version for reproducible deployments, or use
`@latest` to receive the newest release whenever the MCP process starts.

### Option B: from source

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
npm ci
npm test
```

### Option C: Docker

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
cp .env.example .env
# Edit .env and use a long random MCP_HTTP_BEARER_TOKEN.
docker compose up --build -d
```

Compose binds `127.0.0.1:3000`, starts in read-only mode, and stores exports and
theme packages in separate named volumes.

See [Installation and Updates](docs/INSTALLATION.md) for Codex CLI, Claude
Desktop, global npm, source, Docker, verification, update, and removal steps.

## Configuration

Required:

| Variable | Description |
|---|---|
| `LIMESURVEY_URL` | Exact RemoteControl URL, for example `https://survey.example.com/index.php/admin/remotecontrol` |
| `LIMESURVEY_USERNAME` | LimeSurvey service account |
| `LIMESURVEY_PASSWORD` | Service account password |

Important optional variables:

| Variable | Default | Description |
|---|---:|---|
| `LIMESURVEY_AUTH_PLUGIN` | `Authdb` | LimeSurvey authentication plugin |
| `LIMESURVEY_READ_ONLY` | `false` | Block every non-read-only MCP tool before an RPC call |
| `LIMESURVEY_TIMEOUT_MS` | `30000` | RemoteControl request timeout |
| `LIMESURVEY_MAX_RESPONSE_CHARS` | `50000` | Maximum inline result size |
| `LIMESURVEY_EXPORT_DIR` | unset | Dedicated output directory for decoded exports |
| `LIMESURVEY_MAX_EXPORT_BYTES` | `104857600` | Maximum decoded export size |
| `LIMESURVEY_IMPORT_DIR` | unset (falls back to `LIMESURVEY_EXPORT_DIR`) | Dedicated input directory for `import_data_path` reads |
| `LIMESURVEY_MAX_IMPORT_BYTES` | `52428800` | Maximum file size accepted via `import_data_path` |
| `LIMESURVEY_THEME_DIR` | unset | Dedicated output directory for generated theme ZIPs |
| `LIMESURVEY_MAX_THEME_ASSET_BYTES` | `5242880` | Maximum logo and theme entry size |
| `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS` | `false` | Enable non-standard `list_response_exports` |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | Streamable HTTP bind address |
| `MCP_HTTP_PORT` | `3000` | Streamable HTTP port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint |
| `MCP_HTTP_BEARER_TOKEN` | unset | Required for every non-loopback HTTP binding |
| `MCP_HTTP_ALLOWED_HOSTS` | unset | Comma-separated exact Host allowlist |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser Origin allowlist |

The server intentionally does not load `.env` itself. The MCP client, process
manager, or container runtime owns secret injection.

## MCP Client Setup

Codex CLI:

```powershell
codex mcp add limesurvey `
  --env "LIMESURVEY_URL=https://survey.example.com/index.php/admin/remotecontrol" `
  --env "LIMESURVEY_USERNAME=rpc-user" `
  --env "LIMESURVEY_PASSWORD=replace-me" `
  --env "LIMESURVEY_READ_ONLY=true" `
  -- npx -y limesurvey-mcp-server@1.2.2
```

Example for clients that support `mcpServers` configuration:

```json
{
  "mcpServers": {
    "limesurvey": {
      "command": "npx",
      "args": ["-y", "limesurvey-mcp-server@1.2.2"],
      "env": {
        "LIMESURVEY_URL": "https://survey.example.com/index.php/admin/remotecontrol",
        "LIMESURVEY_USERNAME": "rpc-user",
        "LIMESURVEY_PASSWORD": "replace-me",
        "LIMESURVEY_READ_ONLY": "true",
        "LIMESURVEY_THEME_DIR": "C:/limesurvey-mcp/themes"
      }
    }
  }
}
```

For a local build, replace `npx` with `node` and use the absolute path to
`dist/src/index.js` as the first argument.

Restart the MCP client after changing its configuration. Then call
`limesurvey_get_session_key` and `limesurvey_list_surveys` to verify
authentication and read access before enabling writes.

## Streamable HTTP

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3000 \
MCP_HTTP_BEARER_TOKEN='replace-with-a-long-random-token' \
npm start
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health endpoint: `http://127.0.0.1:3000/health`

Non-loopback bindings fail fast without a bearer token. Use a reverse proxy for
TLS and configure Host and Origin allowlists when exposing the server remotely.

## Write Safety

`LIMESURVEY_READ_ONLY=true` blocks all tools that are not annotated as read-only.
The check is enforced by the server and cannot be bypassed through MCP tool
arguments. Read tools remain available.

Additional confirmation literals are required for high-impact actions:

| Action | Required argument |
|---|---|
| All `delete_*` tools | `confirm_destructive_action=true` |
| Participant email tools | `confirm_send_email=true` |
| Survey activation | `confirm_activation=true` |
| Replacing an export or theme ZIP | `overwrite=true` and `confirm_overwrite=true` |
| Assigning a survey theme | `confirm_theme_assignment=true` |

These MCP-only confirmation fields are never forwarded to LimeSurvey.

## Responsive Survey Themes

The theme generator was verified on **2026-07-22** against the current
**LimeSurvey CE 7.0.5** release and the official Bootstrap 5
`fruity_twentythree` manifest. LimeSurvey 7 is the default target; LimeSurvey 6
can be selected explicitly.

Generated themes:

- inherit the installed `fruity_twentythree` core theme instead of copying it;
- contain responsive CSS, fixed mobile breakpoints, print styles, visible focus,
  reduced-motion support, and minimum 44 px controls;
- validate WCAG contrast for body, muted, focus, and primary-button colors;
- use local system font stacks with no third-party font requests;
- contain no JavaScript, tracking, remote CSS imports, or data URLs;
- optionally include a signature-checked PNG or JPEG logo;
- are licensed **GPL-2.0-or-later**, matching the inherited LimeSurvey theme.

Recommended tool sequence:

1. `limesurvey_generate_survey_theme`
2. `limesurvey_validate_survey_theme`; continue only with `valid=true`
3. `limesurvey_get_theme_publication_guide` using the installed version shown in LimeSurvey
4. Import the ZIP under **Configuration > Advanced > Themes > Survey themes**
5. Test an inactive survey on phone, tablet, desktop, keyboard, zoom, RTL, and print
6. `limesurvey_assign_survey_theme` with `confirm_theme_assignment=true`

See [Survey Theme Guide](docs/SURVEY_THEMES.md) for complete examples,
acceptance criteria, Cloud restrictions, community publication, and rollback.

## Secure File Exports

File export tools require `LIMESURVEY_EXPORT_DIR`. File names cannot contain
directories, traversal segments, or null bytes. The server enforces decoded size
limits, creates restrictive files, refuses replacement by default, and returns
the path, size, MIME type, and SHA-256 digest instead of base64 content.

The original RemoteControl export methods remain available for compatibility.
Oversized inline responses are replaced by a marked preview that is not a valid
export file.

## Secure File Imports

`limesurvey_import_survey`, `limesurvey_import_group`, and
`limesurvey_import_question` accept an `import_data_path` argument as an
alternative to inline `import_data`. Set exactly one of the two; the server
reads the file at `import_data_path` from `LIMESURVEY_IMPORT_DIR` (falling
back to `LIMESURVEY_EXPORT_DIR` when unset) and base64-encodes it itself, so a
survey file of any size can be imported with a single tool call instead of an
inline base64 payload. Use `import_data_path` for files at or above roughly
50 KB; reserve inline `import_data` for small files under 200,000 characters
of base64 text.

The path is resolved and checked the same way as export file names: it must
stay inside the configured import directory. Oversized files, missing files,
paths outside the directory, and conflicting/missing parameters all fail with
a distinct error `code` (`IMPORT_FILE_TOO_LARGE`, `IMPORT_FILE_NOT_FOUND`,
`IMPORT_PATH_OUTSIDE_DIR`, `IMPORT_PARAM_CONFLICT`,
`IMPORT_PAYLOAD_TOO_LARGE`, `IMPORT_DIR_NOT_CONFIGURED`) plus a `recovery`
hint. Changing `LIMESURVEY_IMPORT_DIR` or `LIMESURVEY_MAX_IMPORT_BYTES`
requires a full restart of the MCP client process; reconnecting alone does not
reload environment variables.

`import_survey` returns the survey ID LimeSurvey actually used: it keeps the
ID embedded in the file when that ID is free, `destination_survey_id`
overrides it when set, and on an ID collision LimeSurvey silently assigns a
random 6-digit `sid` instead of failing.

## Capability Detection

The server prints a startup preflight to stderr for every optional directory
(`LIMESURVEY_EXPORT_DIR`/`LIMESURVEY_IMPORT_DIR`/`LIMESURVEY_THEME_DIR`) that
is not configured, naming the tools that stay disabled until it is set and
that changing it requires a full restart.

`limesurvey_get_instance_info` makes **no RemoteControl call** by default: it
reports `server_version`, `instance_host` (host only, never credentials),
`transport`, `read_only`, `experimental_methods_enabled`, per-directory
`{configured, path, exists, writable}` checks, and a `capabilities` summary.
Set `probe_instance=true` to additionally call `list_surveys` (connectivity/
auth proof, count only) and `get_site_settings("versionnumber")`, which
requires a superadmin service account and degrades to
`permission_level: "standard"` with `instance_version: null` otherwise. Call
this before relying on file export/import or theming tools.

`limesurvey_list_installed_themes` combines two best-effort signals, since
RemoteControl2 has no official method to enumerate installed themes:
`generated_packages` lists ZIPs/folders already generated locally in
`LIMESURVEY_THEME_DIR`, and `themes_in_use` lists the distinct `template`
values actually assigned to up to `survey_scan_limit` visible surveys (via
`list_surveys` + `get_survey_properties`), which works without a superadmin
account — `"inherit"` is tracked separately as `inherit_count`, not as a
theme. The response always includes the documented admin-UI fallback
(Configuration > Themes) for the complete list.

## Experimental Extension

`list_response_exports` is not part of the official RemoteControl method list.
Its workflow tool is disabled unless the matching LimeSurvey extension is
installed and `LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS=true` is set.

`limesurvey_export_survey_to_file` is likewise experimental: core LimeSurvey
RemoteControl2 has no `export_survey` method at all (verified 2026-07-24
against api.limesurvey.org and the LimeSurvey source). The tool requires
`LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS=true` and only succeeds if a custom
LimeSurvey plugin provides an equivalent method; otherwise it always fails
with a structured `EXPORT_UNSUPPORTED` error. Prefer property-based
verification (`list_groups`, `list_questions`, `get_survey_properties`,
`get_group_properties`, `get_question_properties`) over round-trip diffing
against this tool.

## Development

```bash
npm ci
npm test
npm run inspect
npm pack --dry-run
```

The 38 automated tests use mocked LimeSurvey JSON-RPC responses and cover:

- JSON-RPC 1.0 ordering, session reuse, renewal, and secret handling
- MCP handshake, schemas, annotations, confirmations, and read-only enforcement
- Streamable HTTP bearer authentication and session isolation
- workflow filtering and secure export files
- survey theme ZIP generation, validation, publication guidance, and assignment
- secure file imports via `import_data_path` for survey, group, and question tools
- environment preflight warnings (`envPreflightWarnings`)
- capability detection (`get_instance_info` with and without `probe_instance`,
  `list_installed_themes`) and the experimental, permission-degrading
  `export_survey_to_file` tool

No live LimeSurvey credentials are required. Content evaluations must be created
against a stable test instance; see [evaluations/README.md](evaluations/README.md).

An opt-in live integration runner exercises all 71 tools against disposable,
prefixed test records:

```bash
npm run test:live
```

It requires explicit environment confirmation and an external official
LimeSurvey fixture checkout. Never run it against a production instance.
`cpd_importParticipants` has no matching RemoteControl delete method, so the
runner reports the uniquely named central participant for manual removal. See
[Live Integration Testing](docs/LIVE_TESTING.md).

## Project Structure

```text
src/
  client.ts             JSON-RPC client and session handling
  config.ts             environment validation and secure defaults
  tool-definitions.ts   56 official RemoteControl tools
  workflow-tools.ts     survey, participant, and export workflows
  theme-tools.ts        theme generator, validator, guide, and assignment
  server.ts             MCP registration and central safety enforcement
  http-server.ts        authenticated Streamable HTTP transport
  index.ts              stdio/HTTP entry point
test/                   mocked unit, protocol, transport, workflow, and theme tests
scripts/                opt-in guarded live integration test
docs/                   detailed operational documentation
```

## Compatibility

- Node.js 20, 22, and 24 are tested in CI.
- RemoteControl uses JSON-RPC 1.0 positional parameters as required by LimeSurvey.
- Theme generation supports LimeSurvey 7.x and 6.x with
  `fruity_twentythree`; always validate against the exact installed patch release.
- LimeSurvey Cloud may restrict custom theme import by account or plan. The MCP
  server does not attempt unsupported filesystem installation.

## Security

Read [SECURITY.md](SECURITY.md) before remote deployment. Report vulnerabilities
privately to **security@wagner-emden.de**, not through public issues.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CHANGELOG.md](CHANGELOG.md).

## License

The MCP server source code is licensed under the [MIT License](LICENSE),
Copyright (c) 2026 Wagner-Emden IT Services.

Survey theme ZIPs generated by the server are separately marked and licensed
under **GPL-2.0-or-later** because they are designed to inherit LimeSurvey's GPL
`fruity_twentythree` theme. Customer logos and other supplied assets retain their
own applicable rights and must not be redistributed without permission.

## References

- [LimeSurvey RemoteControl 2](https://www.limesurvey.org/manual/RemoteControl_2_API)
- [RemoteControl API reference](https://api.limesurvey.org/classes/remotecontrol-handle.html)
- [LimeSurvey Themes](https://www.limesurvey.org/manual/Themes/en)
- [Extension compatibility](https://www.limesurvey.org/manual/Extension_compatibility)
- [Current LimeSurvey CE downloads](https://community.limesurvey.org/downloads/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
