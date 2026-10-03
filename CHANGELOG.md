# Changelog

## Unreleased — 0.3.0

- Remove retired build-variant runtime wiring and keep only the Personal build and release configuration.

- Extract bounded deterministic control adapters with semantic control descriptions and guarded exact-option selection.
- Support conservative ARIA single-select listboxes, open Shadow DOM, and non-sandboxed same-origin iframes.
- Add source/target section observation for large forms while retaining the 120-control limit.
- Export the synthetic test portals as a static GitHub Pages demo with a real extension walkthrough recording.
- Add browser regressions for option drift, popup ownership, shadow/frame writes, frame replacement, sections, and static deployment paths.

- Add value-free Profile v2 baselines and revision counters with Profile Drift Detection and explicit batch approval.
- Block missing, type-changed, ambiguous, and new unmapped fields without same-label fallback in saved Profile execution.
- Add Admin Profile export and preview/confirm import with strict schema/version validation and fresh IDs.
- Add synthetic marketplace and fulfilment portable examples and browser regression coverage.

## 0.1.0 — repository readiness

- Added the Personal Chromium extension.
- Added Side Panel configuration for user-supplied Gemini and DeepSeek model names and API keys, with direct provider requests from the extension service worker.
- Keep API keys exclusively in trusted extension session storage; migrate old remembered built-in credentials to session-only storage.
- Added browser-local WebLLM support.
- Added synthetic e-business test pages for marketplace, fulfilment, and modern portal workflows.
- Enable PR/main/manual CI and version-tag Releases with ZIP, SHA-256 checksum, release manifest, browser validation, and package scans.
- Remove legacy `apps/web`, Python platform packages, dormant Information Record APIs/stores, and generic BYO AI matching.
- Upgrade IndexedDB to v8; remove retired stores while preserving Mapping Profiles, settings, and logs.
- Stop tracking generated `dist/` files and scope setup/documentation to the extension.
- Added public-project security reporting, support, maintainer, governance, conduct, and CODEOWNERS files using `rekeyzero@outlook.com` as the private contact.
- Licensed the repository under the MIT License.
