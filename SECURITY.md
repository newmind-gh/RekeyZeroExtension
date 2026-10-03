# Security Policy

## Supported versions

Security fixes are applied to the latest released version and the current `main` branch.

| Version | Supported |
|---|---|
| Latest release | Yes |
| `main` | Best effort until the next release |
| Older releases | No |

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability.

Report it privately to **rekeyzero@outlook.com** with:

- the affected version or commit;
- a concise description and potential impact;
- reproducible steps or a proof of concept using synthetic data;
- any suggested mitigation; and
- a safe way to contact you for follow-up.

Do not include real customer data, production credentials, or API keys. If sensitive evidence is required, first ask the security contact to agree on a transfer method.

## Response targets

These are response targets rather than guarantees:

- acknowledgement within 3 business days;
- initial severity assessment within 7 business days;
- status updates at least every 7 business days for confirmed high or critical issues; and
- coordinated disclosure after a fix or mitigation is available.

The maintainer may request additional information, reject reports that cannot be reproduced, or adjust disclosure timing when users need time to upgrade.

## Scope

Security-sensitive areas include:

- provider credentials and extension storage;
- outbound Gemini, DeepSeek, and OpenAI matching requests;
- browser permissions, page observation, and constrained form filling;
- prompt-injection and untrusted DOM boundaries;
- Mapping Profiles and structured data;
- audit logs, diagnostics, and exports;
- dependency and release-package integrity.

The bundled synthetic test-page server is not a production service. Vulnerabilities that require adding an unsupported production backend are outside the repository's supported runtime, but documentation errors that could lead to unsafe deployment are in scope.

## Disclosure and credit

Please allow a reasonable remediation period before public disclosure. Reporter credit is provided when requested, subject to consent and any legal or safety constraints.
