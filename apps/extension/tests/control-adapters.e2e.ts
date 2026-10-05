import { chromium, expect, test } from "@playwright/test"
import { build } from "esbuild"
import { startPortalServer } from "../../../tests/extension-portal/server-core.mjs"
import type { Observation, PageCommand, Plan, Value } from "../src/transfer/types"

test.describe("Bounded deterministic control adapters", () => {
  let portal: Awaited<ReturnType<typeof startPortalServer>>
  let script: string
  test.beforeAll(async () => {
    portal = await startPortalServer()
    script = (await build({ stdin: { contents: 'import { observeTransferPage, handleTransferPage } from "./src/transfer/page"; window.rekeyzeroTest = { observeTransferPage, handleTransferPage };', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife" })).outputFiles[0].text
  })
  test.afterAll(async () => { await portal.close() })
  async function setup(path: string) {
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(`${portal.baseUrl}${path}`)
    await page.addScriptTag({ content: script })
    return { browser, page }
  }
  const observe = (page: import("@playwright/test").Page, groups?: string[]) => page.evaluate((selected) =>
    (window as unknown as { rekeyzeroTest: { observeTransferPage(groups?: string[]): Promise<Observation> } }).rekeyzeroTest.observeTransferPage(selected), groups)
  async function write(page: import("@playwright/test").Page, observation: Observation, label: string, expected: Value, blankOnly = false) {
    const field = observation.fields.find((field) => field.label === label)!
    const plan: Plan = { id: "reviewed-plan", version: 1, snapshotHash: "snapshot", ...observation,
      actions: [{ id: "action", field, before: field.value, expected, status: "ready", reason: "Reviewed by test" }] }
    const request: PageCommand = { type: "TRANSFER_PAGE", operation: "apply", transferId: "transfer", targetId: "target", tabId: 1, documentEpoch: observation.epoch, requestId: "request", plan, actionId: "action", blankOnly }
    return page.evaluate((request) => (window as unknown as { rekeyzeroTest: { handleTransferPage(request: PageCommand): Promise<import("../src/transfer/types").PageReply> } }).rekeyzeroTest.handleTransferPage(request), request)
  }
  test("observes canonical ARIA options and verifies an exact reviewed selection", async () => {
    const { browser, page } = await setup("/adapter-controls")
    try {
      const observation = await observe(page)
      const field = observation.fields.find((field) => field.label === "State")!
      expect(field.adapterId).toBe("aria-listbox")
      expect(field.semanticType).toBe("single_select")
      expect(field.options.map((option) => option.value)).toEqual(["AU-NSW", "AU-VIC"])
      expect((await write(page, observation, "State", "AU-NSW")).action?.status).toBe("filled_verified")
      await expect(page.getByRole("combobox")).toHaveText("New South Wales")
    } finally { await browser.close() }
  })
  test("preserves an unchecked checkbox under the blank-only execution guard", async () => {
    const { browser, page } = await setup("/adapter-controls")
    try {
      await page.locator("body").evaluate((element) => element.insertAdjacentHTML("beforeend", '<label>Subscribed<input type="checkbox" name="subscribed"></label>'))
      const observation = await observe(page)
      expect(observation.fields.find((field) => field.label === "Subscribed")?.value).toBe(false)
      expect((await write(page, observation, "Subscribed", true, true)).action?.status).toBe("preserved_existing")
      await expect(page.getByLabel("Subscribed")).not.toBeChecked()
    } finally { await browser.close() }
  })
  test("blocks option drift, ambiguous popup ownership, and options with submit actions", async () => {
    const { browser, page } = await setup("/adapter-controls")
    try {
      const before = await observe(page)
      await page.locator('[data-value="AU-VIC"]').evaluate((element) => element.setAttribute("data-value", "AU-QLD"))
      expect((await write(page, before, "State", "AU-NSW")).action?.status).toBe("stale")
      await page.getByRole("combobox").evaluate((element) => element.insertAdjacentHTML("afterend", '<button type="button" role="combobox" aria-controls="state-options">Other owner</button>'))
      expect((await observe(page)).fields.find((field) => field.label === "State")?.writable).toBe(false)
      await page.locator('[role="combobox"]').nth(1).evaluate((element) => element.remove())
      await page.locator('[data-value="AU-NSW"]').evaluate((element) => element.setAttribute("type", "submit"))
      expect((await write(page, await observe(page), "State", "AU-NSW")).action?.status).toBe("validation_failed")
    } finally { await browser.close() }
  })
  test("writes through open shadow roots and same-origin frames; rejects replaced frame documents", async () => {
    const { browser, page } = await setup("/adapter-controls")
    try {
      const observation = await observe(page)
      expect(observation.fields.find((field) => field.label === "Postcode")?.scope).toContain("shadow:")
      expect((await write(page, observation, "Postcode", "2000")).action?.status).toBe("filled_verified")
      const fresh = await observe(page)
      const childField = fresh.fields.find((field) => field.scope?.includes("frame:") && field.type === "text")!
      expect(childField).toBeTruthy()
      expect((await write(page, fresh, childField.label, "Example")).action?.status).toBe("filled_verified")
      const stale = await observe(page)
      await page.locator("iframe").evaluate((element) => (element as HTMLIFrameElement).contentWindow!.location.reload())
      await page.waitForTimeout(250)
      expect((await write(page, stale, childField.label, "Replacement")).action?.status).toBe("stale")
    } finally { await browser.close() }
  })
  test("rejects frame route changes and newly visible authentication controls", async () => {
    const { browser, page } = await setup("/adapter-controls")
    try {
      const beforeRoute = await observe(page)
      await page.locator("iframe").evaluate((element) => (element as HTMLIFrameElement).contentWindow!.history.pushState({}, "", "?record=OTHER"))
      expect((await write(page, beforeRoute, "Revenue", "3500000")).action?.status).toBe("stale")
      const beforeLogin = await observe(page)
      await page.locator("body").evaluate((element) => element.insertAdjacentHTML("beforeend", '<label>Password<input type="password"></label>'))
      expect((await write(page, beforeLogin, "Revenue", "3500000")).action?.status).toBe("stale")
    } finally { await browser.close() }
  })
  test("observes a later section without increasing the 120-control bound", async () => {
    const { browser, page } = await setup("/section-form")
    try {
      const full = await observe(page)
      expect(full.truncated).toBe(true)
      expect(full.groups?.map((group) => group.name)).toEqual(["Insured", "Risk", "Claims"])
      const claims = await observe(page, ["Claims"])
      expect(claims.truncated).toBe(false)
      expect(claims.fields).toHaveLength(80)
      expect(claims.fields.every((field) => field.group === "Claims")).toBe(true)
      expect((await write(page, claims, "Claims field 80", "Reviewed value")).action?.status).toBe("filled_verified")
    } finally { await browser.close() }
  })
})
