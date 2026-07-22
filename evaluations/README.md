# Live Evaluations

The ten content evaluations recommended by the MCP builder must be created and
answered against a concrete, stable LimeSurvey test instance. This repository
does not fabricate survey IDs, titles, participants, or responses.

To create a reliable `evaluation.xml`:

1. Connect the server to an immutable test fixture with
   `LIMESURVEY_READ_ONLY=true`.
2. Explore it using survey search, properties, groups, questions, summaries, and
   read-only participant tools.
3. Write ten independent questions that require multiple tool calls and have one
   stable, verifiable answer.
4. Solve and verify every answer before recording it in MCP builder XML format.
5. Never include personal data, participant tokens, or free-text responses.
