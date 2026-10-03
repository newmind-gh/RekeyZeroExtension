import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { route, buildDeltaBundle } from "./server-core.mjs"

const base = process.env.REKEYZERO_DEMO_BASE_PATH ?? "/RekeyZeroExtension"
if (!/^\/(?:[A-Za-z0-9_-]+)?$/.test(base)) throw new Error("Invalid demo base path")
const prefix = base === "/" ? "" : base
const output = fileURLToPath(new URL("../../dist/demo/", import.meta.url))
const paths = ["/transfer-demo", "/transfer-demo/source", "/transfer-demo/marketplace", "/transfer-demo/fulfilment", "/transfer-demo/delta", "/adapter-controls", "/native-form", "/section-form"]
for (const path of paths) {
  const directory = `${output}${path}/`
  await mkdir(directory, { recursive: true })
  const html = route(path).replaceAll('"/transfer-demo', `"${prefix}/transfer-demo`).replaceAll('"/native-form', `"${prefix}/native-form`)
  await writeFile(`${directory}index.html`, html)
}
await writeFile(`${output}/transfer-demo/delta-app.js`, await buildDeltaBundle())
await writeFile(`${output}/.nojekyll`, "")
await writeFile(`${output}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RekeyZero — supervised information transfer</title>
<style>body{font:17px/1.6 system-ui;background:#f3f6fa;color:#17324d;max-width:1000px;margin:60px auto;padding:0 24px}h1{font-size:clamp(32px,6vw,56px);line-height:1.1}.tag{font-weight:700;color:#08766e}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0}a{color:#1853ac}.button{padding:12px 20px;background:#17324d;color:#fff;border-radius:8px;text-decoration:none}section{padding:24px;background:white;border-radius:16px;margin:24px 0}video{width:100%;border-radius:12px}li{margin:12px 0}small{color:#52708a}</style></head><body>
<p class="tag">Open source · browser local · human supervised</p><h1>Stop re-keying between business portals.</h1><p>Semantic mapping + deterministic control adapters.<br>Observe → Map → Validate → Fill → Verify → Human Submit.</p>
<div class="actions"><a class="button" href="${prefix}/transfer-demo/">Try the synthetic portals</a><a class="button" href="https://github.com/newmind-gh/RekeyZeroExtension#build-and-load-the-extension">Install RekeyZero</a><a href="https://github.com/newmind-gh/RekeyZeroExtension">Source code</a></div>
<section><h2>See the actual extension in under a minute</h2><video controls preload="metadata" aria-label="RekeyZero extension walkthrough"><source src="${prefix}/walkthrough.webm" type="video/webm"></video><p><small>Recorded with the real extension and synthetic values. This recording uses a manually reviewed Profile; AI mapping is optional.</small></p></section>
<section><h2>Try it yourself</h2><ol><li>Install the unpacked extension and open the synthetic portals in separate tabs.</li><li>Choose Alpha as the source. Create a Profile for Beta, Gamma, or Delta.</li><li>Review each field relationship. Save the Profile, then click Fill.</li><li>Review the populated target. Click Submit yourself to see a local preview.</li></ol><p>All demo records are synthetic. The demo has no backend, analytics, accounts, or submission service. Demo Submit only opens a local preview dialog.</p></section>
<section><h2>Complex controls, bounded execution</h2><p>Delta uses React controlled inputs and explicit listbox adapters. The <a href="${prefix}/adapter-controls/">adapter fixture</a> includes a standards-based ARIA listbox, an open shadow root, and a same-origin iframe. The <a href="${prefix}/section-form/">large form</a> has 240 fields across three sections; choose a section when creating a Profile.</p><p>AI proposes field relationships. Adapters write exact reviewed values. Neither submits forms or navigates the portal.</p></section></body></html>`)
process.stdout.write(`Built static synthetic demo: ${output}\n`)
