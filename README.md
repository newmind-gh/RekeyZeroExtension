# RekeyZero

![RekeyZero — stop re-keying data between web applications](docs/images/rekeyzero-hero.svg)

<h2 align="center">Stop re-keying data between web applications.</h2>

<p align="center"><strong>AI maps. RekeyZero fills. You review and submit.</strong></p>

RekeyZero is an open-source Chromium extension for safely reusing information from one open web page across one or more target pages. Create reusable Mapping Profiles, fill supported controls through a guarded deterministic executor, review the result, and submit manually.

RekeyZero provides **AI mapping** and **non-AI mapping**. AI mapping proposes semantic relationships between source and target fields for your review; non-AI mapping lets you define those relationships directly. Both produce reusable Profiles for guarded filling.

AI also offers **Prepare Source**: extract documented facts from uploaded files into blank fields on the current source webpage, review evidence directly there, then continue with the existing AI Mapping flow. The webpage remains the canonical source.

[Try the synthetic live demo](https://newmind-gh.github.io/RekeyZeroExtension/) · [Watch the actual extension walkthrough](https://newmind-gh.github.io/RekeyZeroExtension/walkthrough.webm)

The demo uses synthetic records and the real extension. The recorded walkthrough demonstrates non-AI mapping with a manually reviewed Profile. Demo Submit opens a local preview only.

## What RekeyZero does

A typical RekeyZero workflow looks like this:

```text
Source web app
     │
     │ observe current fields and values
     ▼
Mapping Profile
     │
     ├── AI mapping: review proposed field relationships
     │        or
     └── non-AI mapping: define field relationships directly
              │
              ▼
     deterministic validation
              │
              ▼
        guarded fill plan
              │
              ▼
        target web app(s)
              │
              ▼
       review and submit
```

For example, a reusable profile might map:

```text
Customer Name   → Applicant Name
Company         → Business Name
Street Address  → Address
Postcode        → Postal Code
```

The profile stores page and field identities plus mapping policy. It does **not** store the current source-field values. Each **Fill** re-observes the matching open pages and uses the current source data for that transfer batch.

## Why RekeyZero

### Deterministic execution

AI mapping matches fields by their business meaning. Reviewed AI mappings and manually defined non-AI mappings use the same guarded, deterministic fill engine.

RekeyZero does not execute arbitrary model-generated JavaScript or selectors, does not perform unattended navigation, and does not perform final submission.

### User-controlled filling

For each mapped target field, a profile can specify whether RekeyZero should:

- fill only when the field is blank;
- allow overwrite; or
- never fill the field.

Stale or changed page state invalidates prepared actions, and unsupported or ambiguous operations stop for user review.

### Browser-local product state

RekeyZero does not require a RekeyZero backend. Durable product state is kept in browser IndexedDB. Active transfer batches and API keys use extension session storage.

### AI and non-AI mapping

Use **AI ZeroKey Profile** for AI-generated field matches that you review and save. Use **ZeroKey Profile** to define field mappings manually. Both are core mapping workflows that create reusable Profiles.

AI matching receives field labels, control types, groups, and accepted options. It does not receive current source-field values.

Current model options include:

- Qwen2.5 1.5B and Gemma 2 2B through browser-local WebLLM;
- Gemini, OpenAI, Claude, and DeepSeek through their direct APIs, with one provider configuration and a curated model selector for each.

For API models, requests go directly from the extension to the selected provider. There is no RekeyZero proxy. API keys remain in extension session storage and must be entered again after the browser restarts.

### Prepare Source with AI

The AI section appears first and shares one model selector between preparation and mapping. **Use Non-AI ZeroKey Profile** is collapsed by default and contains the existing manual mapping controls.

1. Select the current source tab and choose **Observe source page** to grant website access and inspect its fields.
2. Upload or drop digital PDF, DOCX, XLSX, PPTX, TXT, Markdown, HTML, CSV, or EML documents. Limits are 6 documents, 10 MB per file, and 80,000 Markdown characters across all documents. Scanned/image-only PDFs and MSG are unsupported by this version.
3. **Local privacy processing:** detect and redact PII before AI extraction (best-effort).

## Quick start

### Requirements

- Node.js 22.13 or newer
- npm
- Chrome, Edge, or another compatible Chromium browser version 124 or newer
- WebGPU support when using a browser-local model

### Set up the repository

From the repository root on Windows:

```powershell
.\setup.ps1
```

The setup script installs extension dependencies and runs extension tests and checks. No Python environment, FastAPI service, Ollama instance, or repository `.env` file is required for the Personal extension.

### Build and load the extension

```powershell
cd apps\extension
npm ci
npm run build
```

The stable unpacked build is written to:

```text
dist/rekeyzero-personal
```

Then:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `dist/rekeyzero-personal`.

Later builds overwrite the same directory. Click **Reload** on the installed extension to pick up changes.

## Product screenshots

RekeyZero provides **AI mapping** through **AI ZeroKey Profile** and **non-AI mapping** through **ZeroKey Profile**. Review and save AI-proposed field matches, or define mappings manually. Both workflows use the same guarded, deterministic fill executor.

### Side Panel profiles

![RekeyZero Personal Side Panel showing ZeroKey Profile and AI ZeroKey Profile controls](docs/images/rekeyzero-side-panel.png)

### Source and target tab selection

![RekeyZero ZeroKey Profile editor showing source and target tab selection](docs/images/rekeyzero-profile-tab-selection.png)

### Field mappings

![RekeyZero Field Mappings editor showing source-field selection and existing-value policy](docs/images/rekeyzero-field-mappings.png)

### AI ZeroKey Profile editor

![RekeyZero AI ZeroKey Profile editor showing source and target selection](docs/images/rekeyzero-ai-profile-editor.png)

### Saved AI ZeroKey Profile

![RekeyZero Personal Side Panel showing a saved AI ZeroKey Profile with validated field matches](docs/images/rekeyzero-ai-profile-saved.png)

## RekeyZero Admin

The Side Panel gear button opens the extension-owned Admin page. Its current sections are:

- **Profiles** — view, edit, and delete standard ZeroKey Profiles;
- **AI Setups** — view, edit, and delete AI ZeroKey Profiles;
- **Log** — inspect local AI requests, raw response attempts, parsed mappings, validation results, and runtime errors; and
- **Privacy** — export browser-local admin data or diagnostics and clear local RekeyZero data.

## Safety and privacy

RekeyZero is designed for user-supervised form filling:

- final submission remains manual;
- website and AI-provider host access is optional and requested when needed;
- password fields are excluded from observation, AI context, and fill;
- CAPTCHA and MFA are not bypassed;
- arbitrary model-generated JavaScript and selectors are never executed;
- stale or changed page state invalidates prepared actions;
- existing target values are preserved unless the profile explicitly permits overwrite;
- unsupported or ambiguous operations stop for user review; and
- API keys, information values, profile mappings, page text, and provider response bodies are excluded from diagnostics.

The extension keeps durable product state in browser IndexedDB. Active transfer batches, API keys, and Source Preparation documents/evidence/results use extension session storage. Source Preparation always preserves populated fields. Only locally redacted Markdown goes directly to the selected AI provider when the user chooses extraction; privacy-processing failure prevents transmission. Privacy detection is best-effort, not a guarantee that every sensitive item has been removed.

## Development and validation

From `apps/extension`:

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

Pull requests run extension unit tests, TypeScript checks, and builds. Pushes to `main` and manual CI runs also run Chromium end-to-end validation, scan release packages, and upload release candidates. Version tags run the complete release pipeline before publishing ZIP, SHA-256, and manifest assets to GitHub Releases.

## Release package

Create a release candidate from a clean committed source state:

```powershell
cd apps\extension
npm run test:e2e
npm run release
```

The release command writes the following repository-level outputs:

```text
dist/rekeyzero-personal/
dist/rekeyzero-personal.zip
dist/rekeyzero-personal.manifest.json
dist/rekeyzero-personal.sha256
```

The package process records source identity and file hashes, scans for secrets and remote-hosted executable references, and embeds `release-manifest.json` in the ZIP. The `.sha256` file provides the ZIP checksum. Product changes require a new package and browser validation.

For a release, commit and push the reviewed changes to `main`, wait for CI to pass, then tag that commit `v0.3.0` and push the tag. The tag must match both package and extension versions; the Release workflow validates the source and publishes the assets automatically. Download the ZIP from [GitHub Releases](https://github.com/newmind-gh/RekeyZeroExtension/releases), verify its checksum, extract it, then load the extracted directory through **Load unpacked**.

## Repository layout

```text
apps/extension/          Personal Chromium extension
tests/extension-portal/  Synthetic pages used by extension tests
.github/workflows/       CI and version-tag release workflows
docs/                    Product documentation and screenshots
examples/profiles/       Value-free synthetic portable Profiles
```

This repository contains the extension and synthetic test portals. Legacy web and platform packages have been removed. Generated `dist/` files are ignored by Git and distributed through Actions artifacts and Releases.

## Current limitations

RekeyZero is DOM-first and does not perform unattended navigation, final submission, post-submit business-response capture, visual Computer Use, or arbitrary model actions. Supported controls include common native inputs, textarea, select, checkbox, grouped radio controls, and explicitly adapted listbox/combobox widgets. Standards-based ARIA single-select controls are supported when the complete unique option list and popup ownership are observable. Open Shadow DOM and non-sandboxed same-origin iframes are included in bounded traversal. Closed shadow roots, cross-origin frames, multi-select, free-form custom widgets, PDFs, and canvas remain unsupported. Large forms retain a 120-control limit per observation; select a source or target section when creating a Profile.

Real customer portals require acceptance testing for site-specific autosave, delayed validation, custom controls, and server-side persistence behavior.

## Project documentation

- [Extension details](apps/extension/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)

## License

RekeyZero is licensed under the permissive [MIT Licens](LICENSE.md)
