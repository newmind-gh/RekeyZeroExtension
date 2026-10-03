# Roadmap

## Phase 0 — public repository readiness

- Complete dependency-license and software-bill-of-materials review
- Obtain an independent review of the threat model and security controls

## Phase 1 — extension reliability

- Expand deterministic and AI-assisted field-matching fixtures
- Expand direct-provider contract tests for supported Gemini, DeepSeek, and GPT models
- Add browser acceptance coverage for credential entry, session-only storage, legacy key migration, and removal
- Verify optional host-permission lifecycle across provider and page origins

## Phase 2 — release quality

- Improve reproducible builds and release provenance (package checksums and source manifests are available)
- Add signed release artifacts
- Publish a compatibility matrix for Chromium versions and WebGPU devices
- Add automated dependency update and vulnerability triage policies

## Phase 3 — ecosystem

- Grow the synthetic Mapping Profile example library
- Expand Profile Drift Detection acceptance coverage for real customer portals (initial detection and review are available)
- Expand community value-free Profile examples (import/export and synthetic examples are available)
- Expand deterministic Control Adapters
- Synthetic portal static export, actual extension recording, and GitHub Pages deployment workflow implemented
- Define trademark usage rules before public branding or distribution

### Deterministic adapters

- Implemented: native and explicit listbox adapter registry, conservative generic ARIA single-select, open Shadow DOM, same-origin iframe scopes, and section observation.
- Next: add MUI Autocomplete or React Select adapters only with representative real portal fixtures and the same guarded contract.
- Cross-origin frames, closed roots, multi-select and unrestricted browser automation remain outside current support.
