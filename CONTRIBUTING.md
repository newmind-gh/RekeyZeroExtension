# Contributing

RekeyZero welcomes focused contributions to its supervised browser-local page-to-page transfer extension.

## Principles

- Keep core orchestration provider-agnostic.
- Preserve the zero-rekey principle: known information should flow forward rather than be manually entered again.
- Keep the product flow: Observe → Map → Validate → Deterministic Fill → Verify → Human Submit.
- Prefer structured schemas and deterministic validation at system boundaries.
- Include tests for new behavior and regression fixes.
- Never commit real customer/provider data, credentials, secrets, or proprietary portal content.
- Explain material architecture decisions in the relevant pull request or issue.

## Workflow

1. Create a focused branch from the default branch.
2. Make the smallest coherent change.
3. Add or update tests and documentation.
4. Run repository checks.
5. Open a pull request describing intent, behavior, risk, and validation.

By submitting a contribution, you confirm that you have the right to provide it under the repository's [MIT License](LICENSE.md). A contributor-signoff policy may be added if future legal review requires one.

## Local validation

Use Node.js 22 or later. Install dependencies with lockfile enforcement and run the package checks:

```powershell
cd apps\extension
npm ci
npm test
npm run check

```

Run `npm run test:e2e` from `apps\extension` when changing the Personal Side Panel, permissions, storage, or page-transfer behavior. PR CI runs unit tests and builds; main/manual runs add Chromium E2E and package scans. Version tags publish validated releases.

The repository does not contain the former FastAPI service. `tests/extension-portal` is a synthetic page server for extension validation, not a production backend.

## Commit style

Use clear imperative commits. Conventional Commit prefixes are encouraged:

- `feat:` new capability
- `fix:` defect correction
- `docs:` documentation only
- `refactor:` internal change without user-visible behavior
- `test:` tests
- `chore:` tooling/maintenance

## Control and mapping contributions

Control adapters and mappings must preserve guarded deterministic filling, read-back verification, existing-value protection, and manual submission. Use synthetic fixtures. Do not add backend services, generic automation, or runtime field values to AI matching inputs. Do not commit generated `dist/` files.

## Community standards

- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Report vulnerabilities through [SECURITY.md](SECURITY.md), never a public issue.
- Use [SUPPORT.md](SUPPORT.md) to determine supported scope.
- Explain material architecture decisions in the relevant pull request or issue.
