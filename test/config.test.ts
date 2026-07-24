import assert from "node:assert/strict";
import test from "node:test";
import { envPreflightWarnings } from "../src/config.js";
import type { LimeSurveyConfig } from "../src/types.js";

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

test("envPreflightWarnings warns about every missing optional directory", () => {
  const warnings = envPreflightWarnings(baseConfig);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => warning.includes("LIMESURVEY_EXPORT_DIR")));
  assert.ok(warnings.some((warning) => warning.includes("LIMESURVEY_IMPORT_DIR")));
  assert.ok(warnings.some((warning) => warning.includes("LIMESURVEY_THEME_DIR")));
  for (const warning of warnings) assert.match(warning, /restart/i);
});

test("envPreflightWarnings is empty once every directory is configured", () => {
  const warnings = envPreflightWarnings({
    ...baseConfig,
    exportDir: "./exports",
    importDir: "./imports",
    themeDir: "./themes",
  });
  assert.deepEqual(warnings, []);
});

test("envPreflightWarnings does not warn about import when only the export-dir fallback is set", () => {
  const warnings = envPreflightWarnings({ ...baseConfig, exportDir: "./exports" });
  assert.ok(!warnings.some((warning) => warning.includes("LIMESURVEY_IMPORT_DIR")));
  assert.ok(warnings.some((warning) => warning.includes("LIMESURVEY_THEME_DIR")));
});
