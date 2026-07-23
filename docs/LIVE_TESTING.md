# Live Integration Testing

The live integration runner exercises all 68 MCP tools against a dedicated
LimeSurvey test instance. It is intentionally separate from `npm test`, which
uses mocked JSON-RPC responses and is safe for CI.

## Safety model

- Run only against a disposable or explicitly approved test instance.
- Every survey and local artifact uses the `MCP_LIVE_TEST_` prefix.
- Survey edits and deletions are limited to records created by the current run.
- Cleanup runs in a `finally` block, including surveys, responses, participants,
  generated exports, and generated theme ZIPs.
- No credentials, session keys, response contents, or existing survey titles
  are included in the JSON report.
- The runner refuses to start without the exact confirmation literal.

The `cpd_importParticipants` method is the only cleanup exception. LimeSurvey
RemoteControl can import central participants but does not expose a matching
delete method. The final JSON report lists the unique `@example.invalid`
address under `manual_cleanup` for deletion in LimeSurvey's central participant
management screen.

## Prerequisites

- A dedicated LimeSurvey instance with JSON-RPC enabled.
- A dedicated Super Administrator service account.
- An official LimeSurvey source checkout matching the installed major version.
- A configured local export and theme directory.

The runner currently uses these official fixture paths:

```text
docs/demosurveys/ls7_Samplesurvey_en_de.lss
tests/data/file_upload/limesurvey_group_472.lsg
tests/data/surveys/limesurvey_question_import_question_test.lsq
```

## Environment

Set credentials in the process environment, not in source files or shell
history committed to the repository:

```text
LIMESURVEY_URL=https://survey.example.com/index.php/admin/remotecontrol
LIMESURVEY_USERNAME=mcp-live-test
LIMESURVEY_PASSWORD=replace-me
LIMESURVEY_AUTH_PLUGIN=Authdb
LIMESURVEY_READ_ONLY=false
LIMESURVEY_EXPORT_DIR=./exports
LIMESURVEY_THEME_DIR=./themes
LIMESURVEY_LIVE_FIXTURE_ROOT=/path/to/LimeSurvey
LIMESURVEY_LIVE_TEST_EMAIL=mcp-live-test@example.invalid
LIMESURVEY_LIVE_TEST_CONFIRM=I_UNDERSTAND_THIS_CREATES_AND_DELETES_TEST_DATA
```

`LIMESURVEY_LIVE_TEST_EMAIL` receives invitation, reminder, and registration
test messages. Use a controlled mailbox or an intentionally non-routable
address according to the purpose of the test.

## Run

```bash
npm run test:live
```

Success requires:

- `unique_tools_exercised` equals `68`;
- `failed` equals `0`;
- `untested_tools` equals `0`.

Review `manual_cleanup` even after a successful run. Also verify that no surveys
with the reported `run` prefix remain before ending the test window.
