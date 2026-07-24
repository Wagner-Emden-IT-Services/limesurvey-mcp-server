# Installation and Updates

This guide installs `limesurvey-mcp-server` as a local stdio MCP server. Use
Streamable HTTP only when a central service is required.

## Requirements

- Node.js 20 or newer
- A reachable LimeSurvey installation with JSON-RPC enabled under
  **Configuration > Global settings > Interfaces**
- A dedicated LimeSurvey account with only the permissions required by the
  intended tools
- The exact RemoteControl endpoint, normally:
  `https://survey.example.com/index.php/admin/remotecontrol`

Start with `LIMESURVEY_READ_ONLY=true`. Enable writes only after the connection
and visible surveys have been verified.

## Codex CLI

Register the versioned npm package:

```powershell
$remoteControlUrl = "https://survey.example.com/index.php/admin/remotecontrol"
codex mcp add limesurvey `
  --env "LIMESURVEY_URL=$remoteControlUrl" `
  --env "LIMESURVEY_USERNAME=rpc-user" `
  --env "LIMESURVEY_PASSWORD=replace-me" `
  --env "LIMESURVEY_AUTH_PLUGIN=Authdb" `
  --env "LIMESURVEY_READ_ONLY=true" `
  --env "LIMESURVEY_EXPORT_DIR=C:/limesurvey-mcp/exports" `
  --env "LIMESURVEY_THEME_DIR=C:/limesurvey-mcp/themes" `
  -- npx -y limesurvey-mcp-server@1.2.2
```

The command stores the environment values in the Codex MCP configuration.
Protect that configuration as a secret-bearing file and use a dedicated service
account password.

Restart Codex after adding or changing an MCP server. Confirm registration:

```powershell
codex mcp get limesurvey
codex mcp list
```

## Claude Desktop and JSON MCP Clients

Clients that support the common `mcpServers` format can use:

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
        "LIMESURVEY_AUTH_PLUGIN": "Authdb",
        "LIMESURVEY_READ_ONLY": "true",
        "LIMESURVEY_EXPORT_DIR": "C:/limesurvey-mcp/exports",
        "LIMESURVEY_THEME_DIR": "C:/limesurvey-mcp/themes"
      }
    }
  }
}
```

Use absolute paths. On Windows, either use forward slashes as shown or escape
backslashes in JSON.

## Global npm Installation

A global installation avoids an `npx` package lookup at every MCP process
start:

```bash
npm install --global limesurvey-mcp-server@1.2.2
limesurvey-mcp
```

The binary still requires the LimeSurvey environment variables. Configure the
MCP client to run `limesurvey-mcp` and inject them there.

## Install from Source

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
git checkout v1.2.2
npm ci
npm test
```

Configure the MCP client to run Node.js with the absolute path to
`dist/src/index.js`.

## Docker and Streamable HTTP

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
git checkout v1.2.2
cp .env.example .env
docker compose up --build -d
```

The supplied Compose configuration binds to `127.0.0.1:3000`, enables
read-only mode, and exposes:

- MCP: `http://127.0.0.1:3000/mcp`
- Health: `http://127.0.0.1:3000/health`

Set a long random `MCP_HTTP_BEARER_TOKEN` before using a non-loopback binding.
Terminate TLS at a reverse proxy and configure exact Host and Origin allowlists.

## Verify the Installation

After restarting the MCP client:

1. Call `limesurvey_get_session_key`; expect `status: connected`.
2. Call `limesurvey_list_surveys`; confirm only expected surveys are visible.
3. Call `limesurvey_list_survey_groups`.
4. Keep `LIMESURVEY_READ_ONLY=true` until these checks pass.

For source installations, run the mocked test suite and inspect package
contents:

```bash
npm test
npm pack --dry-run
```

The guarded live suite covers all 71 tools. It creates and deletes prefixed
test records and must only be used on an approved test instance. See
[Live Integration Testing](LIVE_TESTING.md).

## Update

For a pinned `npx` installation, change the version in the MCP configuration
and restart the client:

```text
limesurvey-mcp-server@1.2.2
```

For a global installation:

```bash
npm install --global limesurvey-mcp-server@latest
```

For a source installation:

```bash
git fetch --tags
git checkout v1.2.2
npm ci
npm test
```

Review the [Changelog](../CHANGELOG.md) before enabling writes after an update.

## Remove

Codex CLI:

```powershell
codex mcp remove limesurvey
```

Global npm package:

```bash
npm uninstall --global limesurvey-mcp-server
```

Remove stored MCP credentials and generated export or theme directories
separately according to the local retention policy.

## Troubleshooting

- `Invalid user name or password`: verify the dedicated account, password, and
  `LIMESURVEY_AUTH_PLUGIN`.
- HTML or `404` response: verify the exact `/index.php/admin/remotecontrol`
  endpoint and that JSON-RPC is enabled.
- Write tool blocked: set `LIMESURVEY_READ_ONLY=false` only when writes are
  intended, then restart the MCP client.
- Export or theme workflow unavailable: configure writable absolute
  `LIMESURVEY_EXPORT_DIR` and `LIMESURVEY_THEME_DIR` paths.
- MCP configuration changed but behavior is unchanged: fully restart the MCP
  client so its stdio child process is recreated.
