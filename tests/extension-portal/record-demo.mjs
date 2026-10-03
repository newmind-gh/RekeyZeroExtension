import { chromium, expect } from "../../apps/extension/node_modules/@playwright/test/index.mjs"
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startPortalServer } from "./server-core.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const stage = await mkdtemp(join(tmpdir(), "rekeyzero-demo-"))
const portal = await startPortalServer()
let context
try {
  await cp(join(root, "dist/rekeyzero-personal"), stage, { recursive: true })
  const manifest = JSON.parse(await readFile(join(stage, "manifest.json"), "utf8"))
  manifest.host_permissions = ["http://127.0.0.1/*"]
  await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest))
  await mkdir(join(root, "dist/demo-video"), { recursive: true })
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: false,
    viewport: { width: 1000, height: 800 }, recordVideo: { dir: join(root, "dist/demo-video"), size: { width: 1000, height: 800 } },
    args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
  const page = await context.newPage()
  const source = await context.newPage()
  const target = await context.newPage()
  await source.goto(`${portal.baseUrl}/transfer-demo/source`)
  await target.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
  await page.goto(`${portal.baseUrl}/transfer-demo`)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await pause(4000)
  await page.goto(`${portal.baseUrl}/transfer-demo/source`)
  await pause(4000)
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`)
  const sourceId = await page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, source.url())
  const section = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "ZeroKey Profile", exact: true }) })
  await section.getByRole("button", { name: "Create Profile" }).click()
  await page.getByLabel("Source tab").selectOption(String(sourceId))
  await page.getByRole("button", { name: "Continue to Field Mappings" }).click()
  await page.getByLabel("Profile name").fill("Reviewed marketplace transfer")
  const mappings = [["Registered business", "Legal company name"], ["Operations email", "Contact email"], ["Estimated annual sales", "Annual turnover"], ["Registered region", "State"], ["Store launch date", "Account start date"], ["Business summary", "Business description"]]
  for (const [targetLabel, sourceLabel] of mappings) {
    await page.locator(".profile-field", { hasText: targetLabel }).getByLabel("Use source field").selectOption({ label: sourceLabel })
    await pause(1400)
  }
  await page.getByRole("button", { name: "Save Profile" }).click()
  await pause(4000)
  const profileId = await page.getByLabel("Transfer Profile", { exact: true }).inputValue()
  const operator = await context.newPage()
  await operator.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`)
  // The recorded tab becomes a fresh real target; the extension fills it through its normal guarded engine.
  await page.goto(target.url())
  await target.close()
  await operator.evaluate(async (profileId) => {
    for (const command of [{ type: "USE_MAPPING_PROFILE", profileId }, { type: "RUN_TRANSFER" }]) {
      const reply = await chrome.runtime.sendMessage({ type: "TRANSFER", command })
      if (!reply.ok) throw new Error(reply.error)
    }
  }, profileId)
  await expect(page.getByLabel("Registered business")).toHaveValue("Example Commerce Group Pty Ltd")
  await expect(page.getByLabel("Business summary")).not.toHaveValue("", { timeout: 20000 })
  await pause(8000)
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await pause(5000)
  const video = page.video()
  await page.close()
  await video.saveAs(join(root, "dist/demo/walkthrough.webm"))
  await context.close(); context = undefined
  process.stdout.write("Recorded actual extension walkthrough: dist/demo/walkthrough.webm\n")
} finally {
  await context?.close()
  await portal.close()
  // stage is created by mkdtemp and contains only the isolated extension copy.
  await rm(stage, { recursive: true, force: true })
}
