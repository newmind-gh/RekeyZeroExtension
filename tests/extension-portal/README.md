# RekeyZero deterministic extension portal

This synthetic local portal implements the compatibility classes used by release validation. Start it with:

```powershell
node tests/extension-portal/server.mjs
```

Routes cover native and controlled inputs, select/radio/checkbox controls, multi-step and dynamic URLs, success/rejection/validation responses, ambiguous and destructive actions, iframe and Shadow DOM boundaries, oversized forms, adversarial labels, file upload, and rich text.

## Four-system batch-transfer scenario

Open `http://127.0.0.1:4178/transfer-demo` after starting the server. The workspace links to four deliberately different applications:

- **System Alpha CRM** (`/transfer-demo/source`) is the populated, read-only source customer profile.
- **System Beta Marketplace Portal** (`/transfer-demo/marketplace`) is an empty seller-onboarding target with marketplace-specific labels and field names.
- **System Gamma Fulfilment** (`/transfer-demo/fulfilment`) is a fulfilment-partner target with a different layout, different field names, select values, and one protected existing value.
- **System Delta Modern Portal** (`/transfer-demo/delta`) is a real React target with controlled inputs, adapter-backed custom comboboxes, and dependent-control replacement.

Open Alpha and any target pages in separate tabs, then create a Mapping Profile that selects Alpha as the source and maps Beta, Gamma, and/or Delta as targets. Gamma exercises select conversion, visible application identity, and explicit existing-value policy. Delta exercises React state, explicit custom-control adapters, and dynamic dependent controls. RekeyZero must not navigate or submit any target form.

File upload, rich text, cross-origin or sandboxed frames, and closed Shadow DOM remain unsupported. Open Shadow DOM and same-origin frame fields are traversed with per-document tokens and parent-scope connectivity checks.

## Portable Profile examples

The repository includes `examples/profiles/synthetic-marketplace.json` and `synthetic-fulfilment.json` for RekeyZero v0.2.0+. They target the default fixture origin `http://127.0.0.1:4178`; use the Alpha source tab and the matching Beta or Gamma target tab. Import in Admin, preview the origin and overwrite policies, then confirm. Both examples use blank-only policy. Gamma's existing company value stays protected.

Browser regressions mutate these synthetic pages to exercise added/deleted/type-changed/ambiguous fields, human drift review, stale approval, baseline revisions, and portable import/export. Profile tests preserve the manual-submit boundary; separate adapter regressions cover the new deterministic control and traversal capabilities.

## Public synthetic demo

Build with `node tests/extension-portal/build-demo.mjs` after installing extension dependencies. The default base path is `/RekeyZeroExtension`; set `REKEYZERO_DEMO_BASE_PATH=/` for root hosting or a repository name for project Pages. Output is ignored `dist/demo/`, with Alpha/Beta/Gamma/Delta, adapter and section fixtures, and no server APIs.

After `npm --prefix apps/extension run check` and Playwright Chromium installation, run `node tests/extension-portal/record-demo.mjs` to record the real extension with synthetic values and reviewed manual mappings. The recording exercises the normal Profile UI and guarded fill engine; it does not simulate fill with demo JavaScript. The resulting WebM is included in the Pages artifact.

The `Synthetic demo` Actions workflow builds, records, tests repository-relative routes and local-only preview Submit behavior, then deploys through GitHub Pages. Enable **GitHub Actions** as the repository Pages source. Neither test server submission endpoints nor extension artifacts are included in the public static demo.
