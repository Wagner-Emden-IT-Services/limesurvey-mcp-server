# Security Policy

## Supported versions

| Version | Supported |
|---|:---:|
| 1.2.x | Yes |
| < 1.2 | No |

## Reporting a vulnerability

Do not disclose security vulnerabilities in a public GitHub issue.

Email **security@wagner-emden.de** with:

- a description of the vulnerability;
- reproducible steps or a proof of concept;
- the expected impact;
- affected versions and deployment mode;
- a suggested remediation, if available.

We aim to acknowledge reports within 48 hours. After a fix is available, we may
publish a GitHub Security Advisory and credit the reporter unless anonymity was
requested.

## Sensitive data

- Never commit `.env` files, LimeSurvey credentials, participant tokens, survey
  responses, generated exports, or customer theme assets.
- Use HTTPS for non-local LimeSurvey endpoints.
- Keep `LIMESURVEY_READ_ONLY=true` unless write tools are required.
- Use a dedicated least-privilege LimeSurvey service account.
- Require bearer authentication and TLS when exposing Streamable HTTP remotely.
- Treat imported themes as executable presentation code. Only trusted users
  should receive LimeSurvey's global Templates import permission.
