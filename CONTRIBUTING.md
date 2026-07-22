# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development setup

```bash
git clone https://github.com/Wagner-Emden-IT-Services/limesurvey-mcp-server.git
cd limesurvey-mcp-server
npm ci
npm test
```

The automated tests use mocked JSON-RPC responses and do not require a live
LimeSurvey instance. Never use production credentials or participant data in
tests, fixtures, logs, issues, or pull requests.

## Pull requests

1. Keep changes focused and explain the user-visible behavior.
2. Add or update tests for changed tools, schemas, transports, and security rules.
3. Run `npm test` and `npm pack --dry-run` before opening the pull request.
4. Update `README.md`, `.env.example`, and `CHANGELOG.md` when behavior or
   configuration changes.
5. Preserve complete official RemoteControl coverage and MCP tool annotations.
6. Do not add non-standard LimeSurvey RPC methods without an explicit opt-in.

Report vulnerabilities according to [SECURITY.md](SECURITY.md), not through a
public issue.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository. Generated survey theme packages remain
GPL-2.0-or-later as declared in their manifests.
