import { chromium, expect, test } from "@playwright/test"
import type { BrowserContext, Page, Worker } from "@playwright/test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { officeBuffer, pdfBuffer } from "./source-document-fixtures"
import { startPortalServer } from "../../../tests/extension-portal/server-core.mjs"
import { extensionOutputDirectory } from "../build-output"
import type { Observation } from "../src/transfer/types"

const documentText = `Organisation: Example Pty Ltd
Turnover: $12.5m
State: New South Wales
Start date: 5 October 2026
Subscribed: Yes
Contact email: customer@example.com
PRIVATE_DOCUMENT_CONTENT_7481`
const form = `<!doctype html><html><head><title>Prepare Source test</title><style>body{min-height:1800px}form{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:700px}label{display:flex;flex-direction:column;align-items:flex-start}</style></head><body>
<h1 data-application-id="PREP-001">Application PREP-001</h1><form id="organisation">
<label>Organisation name<input name="organisation"></label>
<label>Turnover<input name="turnover" type="number" required></label>
<label>State<select name="state"><option value="">Choose</option><option value="NSW">NSW</option><option value="VIC">VIC</option></select></label>
<label>Start date<input name="started" type="date" required></label>
<label>Subscribed<input name="subscribed" type="checkbox"></label>
<label>Email<input name="email" type="email"></label>
<label>Existing reference<input name="existing" value="PRIVATE_POPULATED_9321"></label>
<button type="submit">Submit</button></form><script>document.querySelector('form').onsubmit=(event)=>event.preventDefault()</script></body></html>`


test.describe.serial("AI Prepare Source", () => {
  test.describe.configure({ timeout: 300_000 })
  let context: BrowserContext
  let source: Page
  let panel: Page
  let background: Worker
  let tabId: number
  let portal: Awaited<ReturnType<typeof startPortalServer>>
  let staged: string
  async function request<T = unknown>(message: Record<string, unknown>): Promise<T> {
    const reply = await panel.evaluate(async (message) => chrome.runtime.sendMessage(message), message)
    if (!reply.ok) throw new Error(reply.error)
    return reply.data as T
  }
  async function installMock(mode: "normal" | "delayed" | "invalid" = "normal") {
    await background.evaluate((mode) => {
      const state = globalThis as typeof globalThis & { prepareCalls: Array<{ body: Record<string, unknown>; fields: Array<{ fieldKey: string; label: string }> }>; finishPrepare?: () => void }
      state.prepareCalls = []
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(String(options?.body))
        const text = body.messages[0].content as string
        if (!text.startsWith("{")) {
          const properties = body.output_config.format.schema.properties.decisions.items.properties
          return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ decisions: properties.target.enum.map((target: string) => ({
            target, source: properties.source.enum.find((source: string | null) => source?.startsWith("Organisation name")) ?? null,
          })) }) }] }))
        }
        const input = JSON.parse(text)
        state.prepareCalls.push({ body, fields: input.fields })
        if (mode === "delayed") await new Promise<void>((resolve) => { state.finishPrepare = resolve })
        if (mode === "invalid") return new Response(JSON.stringify({ content: [{ type: "text", text: "PRIVATE_DOCUMENT_CONTENT_7481 invalid JSON" }] }))
        const facts: Record<string, { value: string; quote: string }> = {
          "Organisation name": { value: "Example Pty Ltd", quote: "Organisation: Example Pty Ltd" },
          Turnover: { value: "$12.5m", quote: "Turnover: $12.5m" }, State: { value: "New South Wales", quote: "State: New South Wales" },
          "Start date": { value: "5 October 2026", quote: "Start date: 5 October 2026" }, Subscribed: { value: "Yes", quote: "Subscribed: Yes" },
        }
        const email = input.documents[0].markdown.match(/Contact email: (\[EMAIL_[^\]]+\])/);
        if (email) facts.Email = { value: email[1], quote: email[0] }
        const decisions = input.fields.map((field: { fieldKey: string; label: string }) => {
          const candidate = facts[field.label]
          const fact = candidate && input.documents[0].markdown.includes(candidate.quote) ? candidate : undefined
          return fact ? { fieldKey: field.fieldKey, status: "found", value: fact.value,
            evidence: [{ documentId: input.documents[0].documentId, page: null, quote: fact.quote }] }
            : { fieldKey: field.fieldKey, status: "not_found", value: null, evidence: [] }
        })
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ decisions }) }], stop_reason: "end_turn" }))
      }
    }, mode)
  }
  test.beforeAll(async () => {
    portal = await startPortalServer()
    staged = mkdtempSync(join(tmpdir(), "rekeyzero-prepare-e2e-"))
    cpSync(extensionOutputDirectory(), staged, { recursive: true })
    const manifestFile = join(staged, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
    manifest.host_permissions = ["http://127.0.0.1/*", "https://api.anthropic.com/*"]
    writeFileSync(manifestFile, JSON.stringify(manifest))
    context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${staged}`, `--load-extension=${staged}`] })
    background = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    await context.route(`${portal.baseUrl}/prepare-source**`, (route) => route.fulfill({ contentType: "text/html", body: form }))
    source = await context.newPage()
    await source.goto(`${portal.baseUrl}/prepare-source`)
    panel = await context.newPage()
    await panel.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)
    tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id!, source.url())
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await request({ type: "PERSONAL_CONFIGURE_API_MODEL", modelId: "personal-claude-api-v1", model: "claude-haiku-4-5", apiKey: "prepare-e2e-fixture-key", rememberKey: false })
    await panel.reload()
  })
  test.afterAll(async () => { await context?.close(); await portal?.close(); if (staged) rmSync(staged, { recursive: true, force: true }) })
  async function digitalPdf() {
    const page = await context.newPage()
    try { await page.setContent("<p>Organisation: Example Pty Ltd</p>"); return await page.pdf() }
    finally { await page.close() }
  }
  const waitForDocuments = () => expect(panel.getByRole("button", { name: "Upload documents", exact: true })).toBeEnabled({ timeout: 300_000 })
  const uploadText = async () => {
    await panel.getByLabel("Source documents").setInputFiles({ name: "application.txt", mimeType: "text/plain", buffer: Buffer.from(documentText) })
    await waitForDocuments()
  }

  test("fills blank source controls, annotates evidence, preserves existing values, and safely undoes user-reviewed edits", async () => {
    await expect(panel.getByRole("combobox", { name: "AI Model", exact: true })).toHaveCount(1)
    await expect(panel.locator(".non-ai-profile")).not.toHaveAttribute("open")
    await expect(panel.getByRole("region", { name: "Prepare Source with AI" })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Extract & fill source" })).toBeDisabled()
    await installMock()
    await uploadText()
    await expect(panel.getByRole("button", { name: "Extract & fill source" })).toBeEnabled()
    const before = await request<{ source: Observation }>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })
    const formBefore = await source.locator("form").innerHTML()
    const controlBefore = await source.getByLabel("Organisation name").boundingBox()
    await source.evaluate(() => {
      const state = window as typeof window & { formMutations: number }
      state.formMutations = 0
      new MutationObserver((records) => { state.formMutations += records.length }).observe(document.querySelector("form")!, { subtree: true, childList: true, attributes: true })
    })
    await panel.getByRole("button", { name: "Extract & fill source" }).click()
    await expect(panel.getByText("Review on the source page", { exact: true })).toBeVisible()
    await expect(source.getByLabel("Organisation name")).toHaveValue("Example Pty Ltd")
    await expect(source.getByLabel("Turnover")).toHaveValue("12500000")
    await expect(source.getByRole("combobox", { name: "State", exact: true })).toHaveValue("NSW")
    const dateSurvivedPrivacy = await background.evaluate(async (tabId) => {
      const key = `rekeyzeroSourcePrepareDraft:v2:${tabId}`
      const stored = await chrome.storage.session.get(key)
      const doc = stored[key]?.[0]
      return { canonical: doc?.markdown.includes("5 October 2026"), redacted: doc?.privacy.redactedMarkdown.includes("5 October 2026"),
        protectedBy: doc?.privacy.findings.filter((finding: { placeholder: string }) => doc.privacy.entityMap[finding.placeholder]?.includes("October")).map((finding: { type: string }) => finding.type) }
    }, tabId)
    expect(dateSurvivedPrivacy).toEqual({ canonical: true, redacted: true, protectedBy: [] })
    await expect(source.getByLabel("Start date")).toHaveValue("2026-10-05")
    await expect(source.getByLabel("Subscribed")).not.toBeChecked()
    await expect(source.getByLabel("Existing reference")).toHaveValue("PRIVATE_POPULATED_9321")
    await expect(source.getByLabel("Email")).toHaveValue("customer@example.com")
    await expect(panel.locator("body")).not.toContainText("customer@example.com")
    await expect(source.getByRole("button", { name: "AI filled", exact: true })).toHaveCount(5)
    expect(await source.locator("form").innerHTML()).toBe(formBefore)
    expect(await source.getByLabel("Organisation name").boundingBox()).toEqual(controlBefore)
    expect(await source.evaluate(() => (window as typeof window & { formMutations: number }).formMutations)).toBe(0)
    await expect(source.locator("form [data-rekeyzero-ui]")).toHaveCount(0)
    await expect(source.locator("body > [data-rekeyzero-ui=source-overlay]")).toHaveCount(1)
    await expect(panel.getByText(/0 preserved during extraction/)).toBeVisible()
    await source.getByLabel("Organisation name").click()
    await expect(source.getByText("application.txt\n“Organisation: Example Pty Ltd”", { exact: true })).toBeHidden()
    await source.getByRole("button", { name: "AI filled", exact: true }).first().click()
    await expect(source.getByText("application.txt\n“Organisation: Example Pty Ltd”", { exact: true })).toBeVisible()
    await panel.getByRole("button", { name: "Show evidence", exact: true }).click()
    await expect(source.getByText("application.txt\n“State: New South Wales”", { exact: true })).toBeVisible()
    await panel.getByRole("button", { name: "Hide evidence", exact: true }).click()
    await source.evaluate(() => { document.querySelector("form")!.style.marginTop = "400px"; window.scrollTo(0, 200) })
    await expect.poll(async () => {
      const badge = await source.getByRole("button", { name: "AI filled", exact: true }).first().boundingBox()
      const control = await source.getByLabel("Organisation name").boundingBox()
      return badge && control ? Math.abs(badge.y - control.y) : 1000
    }).toBeLessThan(2)
    await source.evaluate(() => { document.querySelector("form")!.style.marginTop = ""; window.scrollTo(0, 0) })
    const after = await request<{ source: Observation }>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })
    expect(after.source.fields).toHaveLength(7)
    expect(after.source.structure).toBe(before.source.structure)
    expect(after.source.template).toBe(before.source.template)
    const calls = await background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls)
    expect(JSON.stringify(calls)).toContain("Example Pty Ltd")
    expect(JSON.stringify(calls)).not.toContain("customer@example.com")
    expect(JSON.stringify(calls)).toContain("5 October 2026")
    await expect(panel.getByText(/items detected and protected/)).toBeVisible()
    await panel.getByLabel("Privacy details for application.txt").getByText("View details").click()
    await expect(panel.getByLabel("Privacy details for application.txt")).toContainText(/email/i)
    expect(JSON.stringify(calls)).not.toContain("PRIVATE_POPULATED_9321")
    expect(JSON.stringify(calls)).not.toContain("prepare-e2e-fixture-key")
    expect((calls as Array<{ fields: Array<{ label: string }> }>)[0].fields.some((field) => field.label === "Subscribed")).toBe(false)
    await source.getByLabel("Organisation name").fill("Reviewed organisation")
    await expect(source.getByRole("button", { name: "AI filled", exact: true })).toHaveCount(5)
    await expect(source.getByRole("button", { name: "Reviewed / edited", exact: true })).toHaveCount(0)
    await panel.getByRole("button", { name: "Undo AI fill", exact: true }).click()
    await expect(panel.getByText("Undo finished: 4 restored · 1 user values preserved · 0 stale", { exact: true })).toBeVisible()
    await expect(source.getByLabel("Organisation name")).toHaveValue("Reviewed organisation")
    await expect(source.getByLabel("Turnover")).toBeEmpty()
    await expect(source.getByRole("combobox", { name: "State", exact: true })).toHaveValue("")
    await expect(source.getByLabel("Start date")).toBeEmpty()
    await expect(source.getByLabel("Subscribed")).not.toBeChecked()
    await expect(source.locator("[data-rekeyzero-ui]")).toHaveCount(0)
    for (const type of ["PERSONAL_EXPORT", "PERSONAL_EXPORT_DIAGNOSTICS", "PERSONAL_EXPORT_RECOVERY"]) {
      expect(JSON.stringify(await request({ type }))).not.toMatch(/PRIVATE_DOCUMENT_CONTENT|Example Pty Ltd|Organisation:|prepare-e2e-fixture-key/)
    }
    expect(await request({ type: "PERSONAL_GET_LLM_LOGS" })).toEqual([])
  })

  test("marks conflicts when the user fills a blank field while extraction is running", async () => {
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
    await source.reload()
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await uploadText()
    await installMock("delayed")
    await panel.getByRole("button", { name: "Extract & fill source" }).click()
    await expect.poll(async () => background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls.length)).toBe(1)
    await source.getByRole("combobox", { name: "State", exact: true }).selectOption("VIC")
    await background.evaluate(() => (globalThis as typeof globalThis & { finishPrepare?: () => void }).finishPrepare?.())
    await expect(panel.getByText("Review on the source page", { exact: true })).toBeVisible()
    await expect(source.getByRole("combobox", { name: "State", exact: true })).toHaveValue("VIC")
    await expect(source.getByRole("button", { name: "Existing value preserved", exact: true })).toHaveCount(1)
    await source.getByRole("button", { name: "Existing value preserved", exact: true }).click()
    await expect(source.getByText("RekeyZero preserved the existing value. Review and edit it directly on this page.", { exact: true })).toBeVisible()
    await expect(panel.getByText(/1 conflicts to review/)).toBeVisible()
  })

  test("keeps malformed extraction output out of durable logs and exports", async () => {
    await expect(panel.getByText("Documents, local sensitive-value mappings, evidence and Undo history will be cleared. Filled source values will remain.", { exact: true })).toBeVisible()
    const filledBeforeClear = await source.getByLabel("Organisation name").inputValue()
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
    await expect(source.getByLabel("Organisation name")).toHaveValue(filledBeforeClear)
    await expect(source.locator("[data-rekeyzero-ui]")).toHaveCount(0)
    expect(await request({ type: "PERSONAL_GET_PREPARE_SOURCE" })).toBeNull()
    await source.reload()
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await uploadText()
    await installMock("invalid")
    await panel.getByRole("button", { name: "Extract & fill source" }).click()
    await expect(panel.getByRole("alert")).toContainText("invalid extraction JSON twice")
    await expect(source.getByLabel("Organisation name")).toBeEmpty()
    expect(await request({ type: "PERSONAL_GET_LLM_LOGS" })).toEqual([])
    expect(JSON.stringify(await request({ type: "PERSONAL_EXPORT_DIAGNOSTICS" }))).not.toContain("PRIVATE_DOCUMENT_CONTENT_7481")
  })

  test("skips replaced controls while extraction is pending", async () => {
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
    await source.reload()
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await uploadText()
    await installMock("delayed")
    await panel.getByRole("button", { name: "Extract & fill source" }).click()
    await expect.poll(async () => background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls.length)).toBe(1)
    await source.evaluate(() => {
      const original = document.querySelector('input[name="organisation"]')!
      original.replaceWith(original.cloneNode(true))
    })
    await background.evaluate(() => (globalThis as typeof globalThis & { finishPrepare?: () => void }).finishPrepare?.())
    await expect(panel.getByRole("alert")).toContainText("source page changed")
    await expect(source.getByLabel("Organisation name")).toBeEmpty()
    await expect(source.getByLabel("Turnover")).toBeEmpty()
    await expect(source.locator("[data-rekeyzero-ui]")).toHaveCount(0)
  })

  test("parses text PDF and DOCX locally, rejects image-only PDF, and discards session documents on navigation", async () => {
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
    const callCount = await background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls.length)
    await panel.getByLabel("Source documents").setInputFiles({ name: "application.pdf", mimeType: "application/pdf", buffer: await digitalPdf() })
    await waitForDocuments()
    await expect(panel.getByRole("button", { name: "Remove document application.pdf" })).toBeVisible()
    const pdf = await background.evaluate(async (tabId) => (await chrome.storage.session.get(`rekeyzeroSourcePrepareDraft:v2:${tabId}`))[`rekeyzeroSourcePrepareDraft:v2:${tabId}`], tabId)
    expect(pdf[0].markdown).toContain("Organisation: Example Pty Ltd")
    await panel.getByLabel("Source documents").setInputFiles({ name: "application.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: officeBuffer("docx") })
    await waitForDocuments()
    await expect(panel.getByRole("button", { name: "Remove document application.docx" })).toBeVisible()
    const parsed = await background.evaluate(async (tabId) => (await chrome.storage.session.get(`rekeyzeroSourcePrepareDraft:v2:${tabId}`))[`rekeyzeroSourcePrepareDraft:v2:${tabId}`], tabId)
    expect(parsed[1].markdown).toContain("State: NSW")
    await panel.locator(".source-document-drop").evaluate((element) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(["# Organisation\nExample Pty Ltd"], "notes.md", { type: "text/markdown" }))
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }))
    })
    await waitForDocuments()
    await expect(panel.getByRole("button", { name: "Remove document notes.md" })).toBeVisible()
    await panel.getByLabel("Source documents").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: pdfBuffer() })
    await expect(panel.getByRole("alert")).toContainText("Scanned PDFs are not supported yet")
    expect(await background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls.length)).toBe(callCount)
    await source.goto(`${portal.baseUrl}/prepare-source?new-record=1`)
    await expect.poll(async () => background.evaluate(async (tabId) => Object.keys(await chrome.storage.session.get(null)).filter((key) => key === `rekeyzeroSourcePrepare:${tabId}` || key === `rekeyzeroSourcePrepareDraft:v2:${tabId}`).length, tabId)).toBe(0)
    await expect(source.locator("[data-rekeyzero-ui]")).toHaveCount(0)
  })

  test("converts business formats locally and keeps successful files when another document fails", async () => {
    await source.reload()
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await installMock()
    const files = [
      { name: "application.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: officeBuffer("xlsx") },
      { name: "application.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: officeBuffer("pptx") },
      { name: "application.html", mimeType: "text/html", buffer: Buffer.from("<p>Organisation: Example Pty Ltd</p><script>throw new Error('document executed')</script>") },
      { name: "application.csv", mimeType: "text/csv", buffer: Buffer.from("Organisation,State\nExample Pty Ltd,NSW") },
      { name: "application.eml", mimeType: "message/rfc822", buffer: Buffer.from("Subject: Application\r\nFrom: customer@example.com\r\nContent-Type: text/plain\r\n\r\nOrganisation: Example Pty Ltd") },
      { name: "scan.pdf", mimeType: "application/pdf", buffer: pdfBuffer() },
    ]
    await panel.getByLabel("Source documents").setInputFiles(files)
    await waitForDocuments()
    for (const file of files.slice(0, 5)) await expect(panel.getByRole("button", { name: `Remove document ${file.name}` })).toBeVisible()
    await expect(panel.getByRole("alert")).toContainText("Scanned PDFs are not supported yet")
    const documents = await background.evaluate(async (tabId) => (await chrome.storage.session.get(`rekeyzeroSourcePrepareDraft:v2:${tabId}`))[`rekeyzeroSourcePrepareDraft:v2:${tabId}`], tabId)
    expect(documents).toHaveLength(5)
    expect(documents.every((document: { markdown: string; privacy: { redactedMarkdown: string } }) => document.markdown.includes("Example Pty Ltd") && document.privacy.redactedMarkdown.includes("Example Pty Ltd"))).toBe(true)
    expect(documents[4].privacy.redactedMarkdown).not.toContain("customer@example.com")
    expect(await background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls)).toEqual([])
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
  })

  test("blocks unprocessed drafts and caller-supplied original Markdown before contacting the provider", async () => {
    await uploadText()
    await installMock()
    const saved = await background.evaluate(async (tabId) => (await chrome.storage.session.get(`rekeyzeroSourcePrepareDraft:v2:${tabId}`))[`rekeyzeroSourcePrepareDraft:v2:${tabId}`], tabId)
    await expect(request({ type: "PERSONAL_PREPARE_SOURCE", documentIds: ["not-in-draft"], documents: [{ markdown: "UNPROCESSED_SECRET" }] })).rejects.toThrow("Privacy processing could not complete")
    await background.evaluate(async ({ tabId, saved }) => {
      await chrome.storage.session.set({ [`rekeyzeroSourcePrepareDraft:v2:${tabId}`]: saved.map((document: Record<string, unknown>) => ({ ...document, privacy: undefined })) })
    }, { tabId, saved })
    await expect(request({ type: "PERSONAL_PREPARE_SOURCE", documentIds: [saved[0].id] })).rejects.toThrow("Privacy processing could not complete")
    expect(await background.evaluate(() => (globalThis as typeof globalThis & { prepareCalls: unknown[] }).prepareCalls)).toEqual([])
    await panel.getByRole("button", { name: "Clear documents & evidence", exact: true }).click()
  })

  test("continues through the existing AI Mapping Profile using the populated canonical source", async () => {
    await source.reload()
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId } })
    await uploadText()
    await installMock()
    await panel.getByRole("button", { name: "Extract & fill source" }).click()
    await expect(panel.getByText("Review on the source page", { exact: true })).toBeVisible()
    await context.route(`${portal.baseUrl}/prepare-target`, (route) => route.fulfill({ contentType: "text/html", body: form
      .replace("Prepare Source test", "Prepare Target test").replace("Organisation name", "Registered business").replace('value="PRIVATE_POPULATED_9321"', 'value=""') }))
    const target = await context.newPage()
    await target.goto(`${portal.baseUrl}/prepare-target`)
    await panel.locator(".ai-fill-setup").getByRole("button", { name: "Create Profile", exact: true }).click()
    await panel.locator(".fill-setup-editor").getByLabel("Profile name", { exact: true }).fill("Prepared source AI Profile")
    await expect(panel.locator(".fill-setup-editor .transfer-tabs").getByText("Prepare Target test", { exact: true })).toBeVisible()
    await panel.locator(".fill-setup-editor").getByRole("button", { name: "Save Profile", exact: true }).click()
    await expect.poll(async () => await panel.locator(".fill-setup-editor").count() === 0 ? "saved" : (await panel.locator(".ai-fill-setup [role=alert]").allTextContents()).join(" ") || "saving").toBe("saved")
    await panel.getByRole("button", { name: "Fill with saved AI ZeroKey Profile", exact: true }).click()
    await expect(target.getByLabel("Registered business")).toHaveValue("Example Pty Ltd")
    await expect(target.getByLabel("Turnover")).toHaveValue("12500000")
    await expect(target.getByLabel("Existing reference")).toHaveValue("PRIVATE_POPULATED_9321")
    const profiles = await request<Array<{ id: string; kind: string }>>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } })
    expect(profiles).toHaveLength(1)
    expect(profiles[0].kind).toBe("ai_fill_setup")
    expect(JSON.stringify(await request({ type: "PERSONAL_EXPORT_PROFILE", profileId: profiles[0].id }))).not.toMatch(/PRIVATE_DOCUMENT_CONTENT|Example Pty Ltd|sourceEvidence|extractedValues|prepareResults/)
    await request({ type: "PERSONAL_CLEAR_ALL" })
    expect(await background.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith("rekeyzeroSourcePrepare")).length)).toBe(0)
    await expect(source.locator("[data-rekeyzero-ui]")).toHaveCount(0)
    await target.close()
  })
})
