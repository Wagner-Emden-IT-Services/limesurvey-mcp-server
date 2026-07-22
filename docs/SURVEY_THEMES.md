# Survey Themes with the MCP Server

## Supported baseline

The implementation was verified on July 22, 2026 against LimeSurvey CE 7.0.5
and the current `fruity_twentythree` manifest. The core theme uses Bootstrap 5
in LimeSurvey 6 and 7 and declares compatibility with both major versions.

LimeSurvey publishes frequent patch releases. Before every installation, compare
the version shown in the lower-right corner of the administration interface with:

- https://community.limesurvey.org/downloads/
- https://www.limesurvey.org/manual/Extension_compatibility

The generator writes `7.0` to `config.xml` by default. For an existing 6.x
installation, set `target_limesurvey_major` explicitly to `6`.

## Configuration

```text
LIMESURVEY_THEME_DIR=C:/limesurvey-mcp/themes
LIMESURVEY_MAX_THEME_ASSET_BYTES=5242880
LIMESURVEY_READ_ONLY=false
```

The MCP process only needs write access to `LIMESURVEY_THEME_DIR`; it does not
need direct access to the LimeSurvey filesystem. Docker uses the
`limesurvey_themes` volume.

## Generate a theme

Tool: `limesurvey_generate_survey_theme`

```json
{
  "theme_name": "weit_feedback",
  "title": "WEIT Feedback",
  "description": "Responsive feedback theme",
  "author": "Wagner-Emden IT Services",
  "theme_version": "1.0.0",
  "target_limesurvey_major": "7",
  "primary_color": "#0B6B57",
  "accent_color": "#C84B31",
  "background_color": "#F5F7F6",
  "surface_color": "#FFFFFF",
  "text_color": "#1F2933",
  "muted_text_color": "#52606D",
  "focus_color": "#005FCC",
  "font_style": "system",
  "density": "comfortable",
  "corner_radius_px": 6,
  "content_max_width_px": 960
}
```

The result is a ZIP containing `config.xml` at the archive root,
`css/mcp-theme.css`, and `LICENSE.txt`. An optional logo can be supplied as a
base64 PNG or JPEG. SVG and JavaScript are intentionally rejected because
LimeSurvey treats theme imports as an XSS-sensitive administrator capability.

Generated themes are freely usable under GPL-2.0-or-later. This license is
deliberate because the theme inherits the GPL-licensed `fruity_twentythree`.

## Validate before import

Tool: `limesurvey_validate_survey_theme`

```json
{
  "file_name": "weit_feedback-1.0.0-ls7.zip"
}
```

Continue only when `valid=true`. The validator checks:

- safe ZIP paths and compressed/uncompressed size limits;
- `config.xml` at the archive root;
- theme name, type, GPL license, parent, and major compatibility;
- allowed CSS and image files plus image signatures;
- absence of remote CSS imports, data URLs, and JavaScript expressions;
- responsive rules, keyboard focus, and reduced-motion handling.

## Request installation instructions

Tool: `limesurvey_get_theme_publication_guide`

```json
{
  "theme_name": "weit_feedback",
  "package_file_name": "weit_feedback-1.0.0-ls7.zip",
  "installed_limesurvey_version": "7.0.5",
  "hosting": "self_hosted",
  "publication_scope": "instance"
}
```

The tool compares the package major with the installed version and returns stop
conditions, acceptance checks, Cloud guidance, and rollback steps. Set
`publication_scope=community` for public distribution guidance.

## Import into LimeSurvey

1. Sign in with a trusted account that has the global Templates import permission.
2. Open **Configuration > Advanced > Themes**.
3. Select **Survey themes** and start **Import**.
4. Choose the validated ZIP from `LIMESURVEY_THEME_DIR`.
5. Confirm that `fruity_twentythree` is recognized as the installed parent theme.
6. Preview welcome, question, completion, token, error, print-answer, and
   public-statistics screens in the Theme Editor.

If LimeSurvey Cloud does not show the import control, do not attempt unofficial
filesystem installation. Confirm custom-theme availability for the account or
plan with LimeSurvey support.

## Assign to a test survey

Tool: `limesurvey_assign_survey_theme`

```json
{
  "survey_id": 123456,
  "theme_name": "weit_feedback",
  "confirm_theme_assignment": true
}
```

Read the survey's `template` property with
`limesurvey_get_survey_properties`, then open the survey as a participant in
every configured language. Assign it to a production survey only after review.

## Acceptance and rollback

At minimum, test:

- phone, tablet, desktop, and 200 percent browser zoom;
- keyboard navigation and clearly visible focus;
- required-field and other validation errors;
- long labels, matrix questions, and file uploads;
- right-to-left languages when applicable;
- reduced motion and print output;
- privacy, token, quota, and completion pages.

Record the previous theme name before deployment. Roll back by assigning the
previous installed theme with `limesurvey_assign_survey_theme`; the new package
does not need to be deleted.
