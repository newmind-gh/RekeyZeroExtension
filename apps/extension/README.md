# RekeyZero Personal Browser Extension

The Chromium Manifest V3 extension performs deterministic, browser-local-AI-assisted, and direct-provider-AI-assisted transfers and adds a browser-native RekeyZero Admin page.

The extension does not perform final submission, unattended navigation, or business-response capture.

## Build and load

```powershell
cd apps/extension
npm ci
npm run build
```

Load `dist/rekeyzero-personal` through `chrome://extensions` or `edge://extensions` with Developer mode enabled. Future builds overwrite the same directory, so keep the extension installed and click **Reload** to preserve its unpacked path and browser-local model cache.

Useful validation commands:

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

PR CI runs unit tests, TypeScript checks, and builds. Main/manual CI also runs Playwright Chromium E2E and release scans. Version tags matching the extension and package version trigger validated GitHub Releases. Main and release jobs scan/package first, then extract that ZIP for Chromium E2E (the synthetic fixture adds only its localhost host permission to a temporary test copy). Firefox and Safari are outside the current Chromium Manifest V3 product boundary.

Release candidates are produced with:

```powershell
npm run release
```

Release output is written to the stable repository-level `dist/rekeyzero-personal` path, with matching `.zip`, `.manifest.json`, and `.sha256` files overwritten by each release. Builds are completed in temporary staging and copied into the stable directory before stale assets are removed, so required files such as `content-script.js` are never intentionally absent from the live unpacked path. The embedded release manifest records the source commit or deterministic snapshot hash and the repository's static executable and secret checks.

## Mapping Profile transfer model

The Side Panel is the only transfer UX. Its normal flow is:

```text
Profile dropdown
Create Profile
Open Profile
Fill
Reset
```

**Create Profile** lets the user select one source tab and one or more target tabs, observe those pages, configure target-field relationships and existing-value policy, and save the result. **Open Profile** edits the selected Mapping Profile. **Fill** rebinds the selected Mapping Profile to currently open tabs and executes the deterministic fill. **Reset** clears only the active batch and does not delete saved Mapping Profiles.

Mapping Profiles contain no current customer values. They retain stable page-template and field-template identities plus existing-value policy. Runtime customer values live only in the active source snapshot and transfer session.

The durable transfer mapping source of truth is:

```text
transfer_mapping_profiles
        ↓
   MappingProfile
        ↓
    controller
        ↓
     planner
        ↓
  page executor
```

There is no second destination/mapping persistence layer.

## Page matching and execution safety

The Side Panel dynamically lists open HTTP(S) tabs across browser windows. Website access remains optional and is requested for the exact source/target origins the user chooses.

A saved Mapping Profile identifies source and target page types by stable origin, value-free path shape, observed page template, and normalized title. Field relationships use record-normalized template keys; active execution uses instance keys that preserve stable record/row identity when available.

At Fill time the controller:

1. locates currently open tabs that match the selected Mapping Profile;
2. fails closed on ambiguous source matches;
3. observes and snapshots the source again;
4. verifies source identity/structure before freezing the batch;
5. plans target actions deterministically;
6. checks target state immediately before each write;
7. applies only supported field operations;
8. reads the page back after writes and re-plans untouched actions when dependent page structure changes.

Different existing target values are protected unless the Mapping Profile explicitly permits overwrite. Page/permission changes invalidate ready actions. Unknown Next/Submit controls are never clicked. Cancellation stops unsent actions and retains already-applied field changes.

The worker checkpoints the active batch in `chrome.storage.session`. It allows at most three concurrent sites and one writing target per origin. After worker recovery, uncertain writes are read before replay so already-matching values are not rewritten.

Supported controls include native text/date/number inputs, textarea, single-select, checkbox, grouped radio controls, and the explicit listbox-combobox adapter contract. Unadapted custom widgets, nested frames, Shadow DOM, PDFs and canvas are not filled.

## RekeyZero Admin

The extension-owned options page is **RekeyZero Admin**. The gear icon in the Side Panel header opens it through `chrome.runtime.openOptionsPage()`.

Current Admin sections are:

```text
Profiles
AI Setups
Log
Privacy
```

### Profiles

Profiles lists the Mapping Profiles used by the Side Panel. Users can open, edit, save, and delete them. Profile revisions are broadcast through extension storage so an already-open Side Panel refreshes its Profile dropdown after an Admin change.

Page identity metadata remains protected in Admin. Profile names, field relationships, and existing-value policies can be edited there; rebuilding source or target page structure remains in the Side Panel's **Open Profile** flow.

### AI ZeroKey Profile

The Personal Side Panel includes an **AI ZeroKey Profile** section below ZeroKey Profile, organized around a Profile dropdown with **Create Profile**, **Open Profile**, **Fill**, and **Reset** actions. Source and target tab selection, optional source and target URLs, and the profile name are contained in the Create/Open Profile editor.

The model selector contains the available browser-local WebLLM models plus **Gemini · API**, **DeepSeek · API**, and **GPT · API**. Every model option is selectable. Selecting a local model downloads and loads it in the browser. Selecting an API model shows **API settings** for that provider only, including its model and API-key inputs. GPT defaults to `gpt-5.6-terra`. The extension calls the selected provider directly without a RekeyZero backend proxy. Saved AI profiles use the existing Mapping Profile storage with the `ai_fill_setup` kind and the guarded transfer executor. **Fill** runs the selected profile; the profile-level **Reset** clears only the active batch and retains saved profiles. The API-settings **Reset** restores that provider's default model and clears its API key.

API keys are never read from a repository `.env`. A key stays only in extension session storage and must be entered again after the browser restarts. RekeyZero restricts that storage area to trusted extension contexts. Keys are excluded from normal exports and diagnostics. Resetting an API provider deletes its stored key and provider host permission. Existing remembered provider keys are migrated to session-only storage when their configuration is loaded.

Admin → **AI Setups** lists saved AI ZeroKey Profiles. Model download and enablement are controlled from the Side Panel rather than Admin.

Admin → **Log** stores each LLM request, every raw response attempt, the parsed response, accepted high-confidence model matches, deterministic exact/curated-label fallback additions, and the final mappings. The complete chronological log is displayed as raw JSON in one scrollable window. These logs stay in the browser. Field matching sends labels and control metadata, not source field values.

For browser-local WebLLM matching, each Save reads the current page labels and assigns temporary compact target/source IDs (`t1`, `s1`, and so on). The model returns those IDs, and the extension maps them back to the current observed field identities before validation. This avoids asking small local models to repeat long labels, keeps retries within the local context window, and does not depend on labels from an earlier Save. Safe Gemma shape variations, including a single wrapper array, are normalized locally. Conflicting duplicate decisions are reduced to `null` so no uncertain mapping is applied. A failed first response is retried once inside the same Save action. If both responses remain invalid, their raw text is retained in the local runtime-error log for diagnosis.

The old destination-response extraction path is not part of the current product. The extension does not inspect a post-submit business response to create reusable facts.

### Privacy and host permissions

Password controls are excluded from observation, model context, and fill.

Optional host permission ownership in Personal is limited to:

- configured direct AI-provider origins; and
- origins referenced by saved Mapping Profiles.

The Personal manifest has no mandatory host permissions. HTTPS provider and website origins, plus localhost fixture origins, remain optional and are requested from the user when needed.

When the last Mapping Profile using an origin is deleted, the permission can be removed if no enabled provider still needs that origin.

## Personal persistence

Personal IndexedDB v8 contains only current durable product state:

```text
settings
transfer_mapping_profiles
llm_logs
```

The following dormant Information Record, generic-provider, and old single-page stores are retired and removed on upgrade:

```text
records
revisions
evidence
provider_configs
destinations
mappings
browser_tasks
actions
executions
events
transfer_mappings
transfer_target_groups
```

Upgrade removes these retired stores and their data; existing Mapping Profiles, local-model selection, and logs are preserved. The dormant record import/review APIs and generic BYO-provider path are removed. Mapping Profiles remain the only durable transfer mapping model.

Normal Workspace export contains the current durable stores, including `transfer_mapping_profiles`, and excludes provider API keys. Diagnostics exclude source field values, Mapping Profile content, API keys, page text, and provider response bodies.

## Current architecture constraints

The extension is DOM-first. It does not execute model-generated JavaScript, arbitrary selectors, visual Computer Use, or unattended navigation. Real customer portals still require acceptance testing for site-specific autosave, delayed validation, custom controls, and server-side persistence behavior.

Build, permission, persistence, and validation procedures are documented in this file and the repository README.
