# Changelog

## Unreleased

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
