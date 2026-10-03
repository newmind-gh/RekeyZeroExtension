import { chromium, expect, test } from "@playwright/test"
import type { BrowserContext, Page, Worker } from "@playwright/test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startPortalServer } from "../../../tests/extension-portal/server.mjs"
import { extensionOutputDirectory } from "../build-output"
import type { MappingProfile, Session } from "../src/transfer/types"

type WorkerResponse<T> = { ok: true; data: T } | { ok: false; error: string }

test.describe.serial("Personal Mapping Profile orchestration", () => {
  let context: BrowserContext
  let extensionPage: Page
  let portal: Awaited<ReturnType<typeof startPortalServer>>
  let stagedExtensionPath: string
  let worker: Worker

  test.beforeAll(async () => {
    portal = await startPortalServer()
    stagedExtensionPath = mkdtempSync(join(tmpdir(), "rekeyzero-personal-e2e-"))
    cpSync(extensionOutputDirectory(), stagedExtensionPath, { recursive: true })
    const manifestPath = join(stagedExtensionPath, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { host_permissions?: string[] }
    manifest.host_permissions = ["http://127.0.0.1/*"]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: false,
      args: [`--disable-extensions-except=${stagedExtensionPath}`, `--load-extension=${stagedExtensionPath}`],
    })
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    extensionPage = await context.newPage()
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`)
  })

  test.afterAll(async () => {
    await context.close()
    await portal.close()
    rmSync(stagedExtensionPath, { recursive: true, force: true })
  })

  async function request<T>(message: Record<string, unknown>): Promise<T> {
    const response = await extensionPage.evaluate(async (value) => chrome.runtime.sendMessage(value), message) as WorkerResponse<T>
    if (!response.ok) throw new Error(`Service-worker request failed: ${response.error}`)
    return response.data
  }

  async function saveProfile(state: Session, name: string, definitions: Record<string, Record<string, { source: string; policy?: "blank_only" | "overwrite" | "skip" }>>): Promise<MappingProfile> {
    const sourceFields = new Map(state.source!.fields.map((field) => [field.label, field]))
    return request<MappingProfile>({
      type: "TRANSFER",
      command: {
        type: "SAVE_MAPPING_PROFILE",
        name,
        targets: state.targets.map((target) => ({
          targetId: target.id,
          mappings: target.plan!.actions.map((action) => {
            const configured = definitions[target.title]?.[action.field.label]
            return {
              targetInstanceKey: action.field.instanceKey,
              sourceInstanceKey: configured ? sourceFields.get(configured.source)!.instanceKey : undefined,
              existingValuePolicy: configured?.policy ?? (configured ? "blank_only" : "skip"),
            }
          }),
        })),
      },
    })
  }

  test("opens RekeyZero Admin from the Personal Side Panel", async () => {
    const workspacePromise = context.waitForEvent("page")
    await extensionPage.getByRole("button", { name: "Open RekeyZero Admin" }).click()
    const workspace = await workspacePromise
    await workspace.waitForLoadState("domcontentloaded")
    expect(new URL(workspace.url()).pathname).toBe("/rekeyzero.html")
    await expect(workspace).toHaveTitle("RekeyZero Admin")
    await expect(workspace.getByRole("button", { name: "Profiles" })).toBeVisible()
    await expect(workspace.getByRole("button", { name: "AI Setups" })).toBeVisible()
    await workspace.getByRole("button", { name: "Log", exact: true }).click()
    await expect(workspace.getByRole("heading", { name: "Log", exact: true })).toBeVisible()
    await expect(workspace.getByText("No AI requests or runtime errors have been logged yet.")).toBeVisible()
    await expect(workspace.getByRole("button", { name: "Information to Reuse" })).toHaveCount(0)
    await workspace.close()
    await expect(extensionPage.locator('label:has(select[aria-label="Profile"])')).toHaveCount(0)
    await expect(extensionPage.getByRole("heading", { name: "AI ZeroKey Profile" })).toBeVisible()
    await expect(extensionPage.getByRole("combobox", { name: "AI Model" })).toBeVisible()
    await expect(extensionPage.getByText("API settings", { exact: true })).toHaveCount(0)
    await expect(extensionPage.locator('select[aria-label="AI Model"] option[value="personal-gpt-api-v1"]')).toBeEnabled()
    await extensionPage.getByRole("combobox", { name: "AI Model" }).selectOption("personal-gpt-api-v1")
    await expect(extensionPage.getByText("API settings", { exact: true })).toBeVisible()
    await expect(extensionPage.getByLabel("GPT · API model")).toBeVisible()
    await expect(extensionPage.getByLabel("GPT · API key")).toBeVisible()
    await extensionPage.locator(".ai-fill-setup").getByRole("button", { name: "Create Profile" }).click()
    await expect(extensionPage.getByLabel("Or enter source URL")).toBeVisible()
    await expect(extensionPage.getByLabel(/Additional target URLs/)).toBeVisible()
    await extensionPage.getByRole("button", { name: "Cancel" }).click()
  })

  test("creates, reopens, runs, resets, and deletes a Mapping Profile", async () => {
    for (const profile of await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } })) {
      await request({ type: "TRANSFER", command: { type: "DELETE_MAPPING_PROFILE", profileId: profile.id } })
    }
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    await expect(request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })).rejects.toThrow("Select a Mapping Profile")

    const source = await context.newPage()
    await source.goto(`${portal.baseUrl}/transfer-demo/source`)
    const target = await context.newPage()
    await target.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
    const sourceId = await extensionPage.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/transfer-demo/source` }))[0].id!, portal.baseUrl)
    const targetId = await extensionPage.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/transfer-demo/marketplace` }))[0].id!, portal.baseUrl)

    await extensionPage.reload()
    const profileSection = extensionPage.locator("section.card").filter({
      has: extensionPage.getByRole("heading", { name: "ZeroKey Profile", exact: true }),
    })
    await expect(profileSection.getByRole("button", { name: "Create Profile" })).toBeVisible()
    await expect(profileSection.getByRole("button", { name: "Fill", exact: true })).toBeDisabled()
    await profileSection.getByRole("button", { name: "Create Profile" }).click()
    await extensionPage.getByLabel("Source tab").selectOption(String(sourceId))
    const targetChoice = extensionPage.locator(".transfer-tabs label", { hasText: "System Beta Marketplace Portal" }).locator('input[type="checkbox"]')
    await expect(targetChoice).toBeChecked()
    await extensionPage.getByRole("button", { name: "Continue to Field Mappings" }).click()
    await extensionPage.getByLabel("Profile name").fill("Marketplace seller profile")

    const mappings = [
      ["Registered business", "Legal company name"],
      ["Operations email", "Contact email"],
      ["Estimated annual sales", "Annual turnover"],
      ["Registered region", "State"],
      ["Store launch date", "Account start date"],
      ["Business summary", "Business description"],
    ] as const
    for (const [targetLabel, sourceLabel] of mappings) {
      await extensionPage.locator(".profile-field", { hasText: targetLabel }).getByLabel("Use source field").selectOption({ label: sourceLabel })
    }
    await extensionPage.getByRole("button", { name: "Save Profile" }).click()

    const profile = (await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } }))[0]
    expect(profile.source).not.toHaveProperty("tabId")
    expect(profile.targets[0]).not.toHaveProperty("tabId")
    await expect(extensionPage.getByLabel("Transfer Profile", { exact: true })).toHaveValue(profile.id)

    await profileSection.getByRole("button", { name: "Open Profile" }).click()
    await expect(extensionPage.getByLabel("Profile name")).toHaveValue("Marketplace seller profile")
    await extensionPage.getByRole("button", { name: "Close" }).click()
    await target.close()
    const replacement = await context.newPage()
    await replacement.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
    expect(await replacement.evaluate(() => location.pathname)).toBe("/transfer-demo/marketplace")

    await profileSection.getByRole("button", { name: "Fill", exact: true }).click()
    await expect(replacement.getByLabel("Registered business")).toHaveValue("Example Commerce Group Pty Ltd")
    await expect(replacement.getByLabel("Operations email")).toHaveValue("operations@example.com")
    await expect.poll(async () => (await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).status, { timeout: 15000 }).toBe("completed")
    await expect(extensionPage.getByText(/This batch · completed/)).toBeVisible()

    await profileSection.getByRole("button", { name: "Reset", exact: true }).click()
    await expect(extensionPage.getByText(/This batch/)).toHaveCount(0)
    await profileSection.getByRole("button", { name: "Open Profile" }).click()
    await extensionPage.getByRole("button", { name: "Delete Profile" }).click()
    await expect(extensionPage.getByLabel("Transfer Profile", { exact: true })).toHaveValue("")
    await Promise.all([source.close(), replacement.close()])
    expect(targetId).toBeGreaterThan(0)
  })

  test("fills multiple systems only from the selected Mapping Profile", async () => {
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    const source = await context.newPage()
    const marketplace = await context.newPage()
    const fulfilment = await context.newPage()
    const delta = await context.newPage()
    await source.goto(`${portal.baseUrl}/transfer-demo/source`)
    await marketplace.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
    await fulfilment.goto(`${portal.baseUrl}/transfer-demo/fulfilment`)
    await delta.goto(`${portal.baseUrl}/transfer-demo/delta`)
    const sourceId = await extensionPage.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/transfer-demo/source` }))[0].id!, portal.baseUrl)
    const targetIds = await extensionPage.evaluate(async (origin) => Promise.all(["marketplace", "fulfilment", "delta"].map(async (path) => (await chrome.tabs.query({ url: `${origin}/transfer-demo/${path}` }))[0].id!)), portal.baseUrl)
    let state = await request<Session>({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId } })
    state = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: targetIds } })
    const profile = await saveProfile(state, "Multi-system profile", {
      "System Beta Marketplace Portal": {
        "Registered business": { source: "Legal company name" },
        "Operations email": { source: "Contact email" },
        "Estimated annual sales": { source: "Annual turnover" },
        "Registered region": { source: "State" },
        "Store launch date": { source: "Account start date" },
        "Business summary": { source: "Business description" },
      },
      "System Gamma Fulfilment": {
        "Legal company name": { source: "Legal company name", policy: "overwrite" },
        "Contact email": { source: "Contact email" },
        "Annual revenue": { source: "Annual turnover" },
        "State": { source: "State" },
        "Account start date": { source: "Account start date" },
        "Business description": { source: "Business description" },
      },
      "System Delta Modern Portal": {
        "Legal company name": { source: "Legal company name" },
        "Contact email": { source: "Contact email" },
        "Annual turnover": { source: "Annual turnover" },
        "State": { source: "State" },
        "Industry": { source: "Industry" },
        "Business category": { source: "Business category" },
      },
    })
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    await request({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: profile.id } })
    await request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })
    await expect.poll(async () => (await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).status, { timeout: 15000 }).toBe("completed")

    await expect(marketplace.getByLabel("Registered business")).toHaveValue("Example Commerce Group Pty Ltd")
    await expect(fulfilment.getByLabel("Legal company name")).toHaveValue("Example Commerce Group Pty Ltd")
    await expect(fulfilment.getByLabel("State")).toHaveValue("AU-NSW")
    await expect(delta.getByLabel("Legal company name")).toHaveValue("Example Commerce Group Pty Ltd")
    await expect(delta.getByRole("combobox", { name: "Business category" })).toHaveText("Marketplace seller")
    await Promise.all([source.close(), marketplace.close(), fulfilment.close(), delta.close()])
  })

  test("edits and deletes a Profile in Admin and refreshes the Side Panel", async () => {
    const profile = (await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } }))[0]
    const adminPromise = context.waitForEvent("page")
    await extensionPage.getByRole("button", { name: "Open RekeyZero Admin" }).click()
    const admin = await adminPromise
    await admin.waitForLoadState("domcontentloaded")
    await admin.locator(".profile-list > div", { hasText: profile.name }).getByRole("button", { name: "Open" }).click()
    await admin.getByRole("button", { name: "Edit" }).click()
    await admin.getByLabel("Profile name").fill("Admin-updated profile")
    await admin.getByRole("button", { name: "Save", exact: true }).click()
    await expect(admin.getByText(/Side Panel profile list has been refreshed/)).toBeVisible()
    await expect(extensionPage.getByLabel("Transfer Profile", { exact: true }).locator("option:checked")).toHaveText("Admin-updated profile")

    const source = await context.newPage(), marketplace = await context.newPage(), fulfilment = await context.newPage(), delta = await context.newPage()
    await Promise.all([
      source.goto(`${portal.baseUrl}/transfer-demo/source`),
      marketplace.goto(`${portal.baseUrl}/transfer-demo/marketplace`),
      fulfilment.goto(`${portal.baseUrl}/transfer-demo/fulfilment`),
      delta.goto(`${portal.baseUrl}/transfer-demo/delta`),
    ])
    const profileSection = extensionPage.locator("section.card").filter({
      has: extensionPage.getByRole("heading", { name: "ZeroKey Profile", exact: true }),
    })
    await profileSection.getByRole("button", { name: "Open Profile" }).click()
    await expect(extensionPage.getByLabel("Profile name")).toHaveValue("Admin-updated profile")
    await extensionPage.getByRole("button", { name: "Close" }).click()
    await Promise.all([source.close(), marketplace.close(), fulfilment.close(), delta.close()])

    admin.once("dialog", (dialog) => void dialog.accept())
    await admin.getByRole("button", { name: "Delete" }).click()
    await expect(admin.getByText(/Profile deleted/)).toBeVisible()
    await expect(extensionPage.getByLabel("Transfer Profile", { exact: true })).toHaveValue("")
    await admin.close()
  })
})
