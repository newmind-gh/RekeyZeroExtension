import { createHash } from "node:crypto"
import { chromium, expect, test } from "@playwright/test"
import type { BrowserContext, Page, Worker } from "@playwright/test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startPortalServer } from "../../../tests/extension-portal/server.mjs"
import { extensionOutputDirectory } from "../build-output"
import type { MappingProfile, Session } from "../src/transfer/types"
import type { PersonalAiSettingsView } from "../src/shared/types"

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
    await expect(extensionPage.getByRole("combobox", { name: "AI Model" })).toHaveValue("personal-gemini-api-v1")
    await expect(extensionPage.getByRole("combobox", { name: "Gemini · API model" })).toHaveValue("gemini-3.5-flash-lite")
    expect((await request<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })).apiModelId).toBeNull()
    await expect(extensionPage.locator('select[aria-label="AI Model"] option[value="personal-gpt-api-v1"]')).toBeEnabled()
    await extensionPage.getByRole("combobox", { name: "AI Model" }).selectOption("personal-gpt-api-v1")
    await expect(extensionPage.getByText("API settings", { exact: true })).toBeVisible()
    await expect(extensionPage.getByRole("combobox", { name: "OpenAI · API model" })).toHaveValue("gpt-5.6-luna")
    await expect(extensionPage.getByLabel("OpenAI · API key")).toBeVisible()
    await extensionPage.locator(".ai-fill-setup").getByRole("button", { name: "Create Profile" }).click()
    await expect(extensionPage.getByLabel("Or enter source URL")).toBeVisible()
    await expect(extensionPage.getByLabel(/Additional target URLs/)).toBeVisible()
    await extensionPage.getByRole("button", { name: "Cancel" }).click()
  })

  test("selects curated API models, preserves choices, resets, and clears Claude permissions and secrets", async () => {
    await extensionPage.evaluate(() => {
      const captured: string[][] = []
      Object.assign(globalThis, { requestedApiOrigins: captured })
      chrome.permissions.request = async (permissions) => {
        captured.push(permissions.origins ?? [])
        return true
      }
    })
    await worker.evaluate(() => {
      const original = chrome.permissions.remove.bind(chrome.permissions)
      const captured: string[][] = []
      Object.assign(globalThis, { removedApiOrigins: captured, originalPermissionsRemove: original })
      chrome.permissions.remove = async (permissions) => {
        captured.push(permissions.origins ?? [])
        return original(permissions)
      }
    })
    extensionPage.on("dialog", (dialog) => void dialog.accept())
    try {
      const settings = await request<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })
      const providerSelect = extensionPage.getByRole("combobox", { name: "AI Model" })
      for (const provider of settings.apiModels!) {
        await providerSelect.selectOption(provider.id)
        const modelSelect = extensionPage.getByRole("combobox", { name: `${provider.displayName} model` })
        await expect(modelSelect).toHaveValue(provider.defaultModel)
        await expect(modelSelect.locator("option")).toHaveCount(provider.models.length)
        expect((await request<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })).apiModelId).toBeNull()
      }
      await expect(request({ type: "PERSONAL_CONFIGURE_API_MODEL", modelId: "personal-claude-api-v1",
        model: "unsupported-preview", apiKey: "unsaved-e2e-key", rememberKey: false,
      })).rejects.toThrow("Choose a supported Claude model")

      await providerSelect.selectOption("personal-gpt-api-v1")
      await extensionPage.getByRole("combobox", { name: "OpenAI · API model" }).selectOption("gpt-5.6-terra")
      await extensionPage.getByLabel("OpenAI · API key").fill("openai-e2e-fixture-key")
      await extensionPage.getByRole("button", { name: "Save and select", exact: true }).click()
      await expect(extensionPage.getByRole("status")).toContainText("OpenAI · API is configured and selected.")
      await providerSelect.selectOption("personal-claude-api-v1")
      await extensionPage.getByLabel("Claude · API key").fill("claude-e2e-fixture-key")
      await extensionPage.getByRole("button", { name: "Save and select", exact: true }).click()
      await expect(extensionPage.getByRole("status")).toContainText("Claude · API is configured and selected.")
      await providerSelect.selectOption("personal-gpt-api-v1")
      await expect(extensionPage.getByRole("combobox", { name: "OpenAI · API model" })).toHaveValue("gpt-5.6-terra")
      await providerSelect.selectOption("personal-claude-api-v1")
      await expect(extensionPage.getByRole("combobox", { name: "Claude · API model" })).toHaveValue("claude-haiku-4-5")
      await extensionPage.locator(".api-provider-actions").getByRole("button", { name: "Reset", exact: true }).click()
      await expect(extensionPage.getByRole("status")).toContainText("was reset to its default model")
      let updated = await request<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })
      expect(updated.apiModels!.find((provider) => provider.id === "personal-claude-api-v1")).toMatchObject({
        model: "claude-haiku-4-5", hasKey: false, configured: false,
      })
      await extensionPage.getByLabel("Claude · API key").fill("claude-e2e-fixture-key")
      await extensionPage.getByRole("button", { name: "Save and select", exact: true }).click()
      await expect(extensionPage.getByRole("status")).toContainText("Claude · API is configured and selected.")
      const storage = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)))
      expect(storage).not.toContain("e2e-fixture-key")
      expect(storage).not.toContain("unsaved-e2e-key")
      expect(await request<string>({ type: "PERSONAL_EXPORT" })).not.toContain("e2e-fixture-key")
      await request({ type: "PERSONAL_CLEAR_ALL" })
      updated = await request<PersonalAiSettingsView>({ type: "PERSONAL_GET_AI_SETTINGS" })
      expect(updated.apiModelId).toBeNull()
      expect(updated.apiModels!.every((provider) => !provider.hasKey && !provider.configured)).toBe(true)
      expect(await worker.evaluate(async () => await chrome.storage.session.get(null))).toEqual({})
      const removals = await worker.evaluate(() => (globalThis as typeof globalThis & { removedApiOrigins: string[][] }).removedApiOrigins)
      expect(removals).toContainEqual(["https://api.anthropic.com/*"])
      expect(removals).toContainEqual(settings.apiModels!.map((provider) => `${provider.origin}/*`))
      const grants = await extensionPage.evaluate(() => (globalThis as typeof globalThis & { requestedApiOrigins: string[][] }).requestedApiOrigins)
      expect(grants).toEqual([["https://api.openai.com/*"], ["https://api.anthropic.com/*"], ["https://api.anthropic.com/*"]])
    } finally {
      await worker.evaluate(() => {
        chrome.permissions.remove = (globalThis as typeof globalThis & { originalPermissionsRemove: typeof chrome.permissions.remove }).originalPermissionsRemove
      })
      await extensionPage.reload(); await extensionPage.getByText("Use Non-AI ZeroKey Profile", { exact: true }).click()
    }
    await expect(extensionPage.getByRole("combobox", { name: "Gemini · API model" })).toHaveValue("gemini-3.5-flash-lite")
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

    await extensionPage.reload(); await extensionPage.getByText("Use Non-AI ZeroKey Profile", { exact: true }).click()
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

  for (const change of ["new", "missing", "type", "ambiguous"] as const) {
    test(`reviews ${change} target drift and fills only compatible saved mappings`, async () => {
      await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
      const source = await context.newPage(), target = await context.newPage()
      await source.goto(`${portal.baseUrl}/transfer-demo/source`)
      await target.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
      const [sourceId, targetId] = await extensionPage.evaluate(async (origin) => Promise.all(["source", "marketplace"].map(async (path) =>
        (await chrome.tabs.query({ url: `${origin}/transfer-demo/${path}` }))[0].id!)), portal.baseUrl)
      await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId } })
      const initial = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: [targetId] } })
      const profile = await saveProfile(initial, `Drift ${change}`, { "System Beta Marketplace Portal": {
        "Registered business": { source: "Legal company name" }, "Operations email": { source: "Contact email" },
      } })
      expect(profile.version).toBe(2)
      await target.evaluate((change) => {
        const field = document.querySelector<HTMLInputElement>('[name="seller_legal_entity"]')!
        if (change === "new") {
          const input = document.createElement("input"); input.name = "new_company"; input.setAttribute("aria-label", "Legal company name")
          document.querySelector("form")!.appendChild(input)
        } else if (change === "missing") field.remove()
        else if (change === "type") field.type = "email"
        else field.parentElement!.appendChild(field.cloneNode(true))
      }, change)
      await extensionPage.reload(); await extensionPage.getByText("Use Non-AI ZeroKey Profile", { exact: true }).click()
      await extensionPage.getByLabel("Transfer Profile", { exact: true }).selectOption(profile.id)
      const profileSection = extensionPage.locator("section.card").filter({ has: extensionPage.getByRole("heading", { name: "ZeroKey Profile", exact: true }) })
      await profileSection.getByRole("button", { name: "Fill", exact: true }).click()
      const report = extensionPage.getByLabel("Profile Drift Report")
      await expect(report).toBeVisible()
      await expect(target.getByLabel("Operations email")).toHaveValue("")
      await expect(request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })).rejects.toThrow("Review and approve")
      const prepared = await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })
      const drift = prepared.profileDrift!.reports.find((item) => item.page === "target")!
      if (change === "new") expect(drift.newFields).toContain("Legal company name")
      if (change === "missing") expect(drift.missingMappedFields).toContain("Registered business")
      if (change === "type") expect(drift.changedControlTypes).toContain("Registered business")
      if (change === "ambiguous") expect(drift.ambiguousFields).toContain("Registered business")
      await report.getByRole("button", { name: "Approve compatible fields" }).click()
      await extensionPage.getByRole("button", { name: "Fill 1 target page", exact: true }).click()
      await expect(target.getByLabel("Operations email")).toHaveValue("operations@example.com")
      await expect.poll(async () => (await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).status).not.toBe("running")
      if (change === "new") {
        await expect(target.getByLabel("Registered business")).toHaveValue("Example Commerce Group Pty Ltd")
        await expect(target.getByLabel("Legal company name", { exact: true })).toHaveValue("")
        await profileSection.getByRole("button", { name: "Open Profile" }).click()
        const newField = extensionPage.locator(".profile-field", { hasText: "Legal company name" }).filter({ has: extensionPage.locator('strong:text-is("Legal company name")') })
        await newField.getByLabel("Existing value policy").selectOption("skip")
        await extensionPage.getByRole("button", { name: "Save Profile", exact: true }).click()
        const updated = (await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } })).find((item) => item.id === profile.id)!
        expect(updated.revision).toBe(2)
        await request({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: updated.id } })
        expect((await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).profileDrift).toBeUndefined()
      } else if (change !== "missing") {
        for (const input of await target.getByLabel("Registered business", { exact: true }).all()) await expect(input).toHaveValue("")
      }
      await request({ type: "TRANSFER", command: { type: "DELETE_MAPPING_PROFILE", profileId: profile.id } })
      await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
      await Promise.all([source.close(), target.close()])
    })
  }

  test("requires fresh drift review after page changes and rejects wrong-page candidates", async () => {
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    const source = await context.newPage(), target = await context.newPage()
    await source.goto(`${portal.baseUrl}/transfer-demo/source`); await target.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
    const [sourceId, targetId] = await extensionPage.evaluate(async (origin) => Promise.all(["source", "marketplace"].map(async (path) =>
      (await chrome.tabs.query({ url: `${origin}/transfer-demo/${path}` }))[0].id!)), portal.baseUrl)
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId } })
    const initial = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: [targetId] } })
    const profile = await saveProfile(initial, "Source drift", { "System Beta Marketplace Portal": {
      "Registered business": { source: "Legal company name" }, "Operations email": { source: "Contact email" },
    } })
    await source.getByLabel("Legal company name").evaluate((field) => field.remove())
    const prepared = await request<Session>({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: profile.id } })
    expect(prepared.profileDrift!.reports[0].missingMappedFields).toContain("Legal company name")
    expect(prepared.targets[0].plan!.actions.find((action) => action.field.label === "Registered business")!.status).toBe("unmapped")
    await target.evaluate(() => {
      const input = document.createElement("input"); input.name = "new-field"; input.setAttribute("aria-label", "New field")
      document.querySelector("form")!.appendChild(input)
    })
    await expect(request({ type: "TRANSFER", command: { type: "APPROVE_PROFILE_DRIFT" } })).rejects.toThrow("Page changed")
    await target.evaluate(() => { document.title = "Unrelated portal" })
    await expect(request({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: profile.id } })).rejects.toThrow("Open the target")
    await request({ type: "TRANSFER", command: { type: "DELETE_MAPPING_PROFILE", profileId: profile.id } })
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    await Promise.all([source.close(), target.close()])
  })

  test("exports and previews a value-free Profile, imports a new copy, and refreshes the Side Panel", async () => {
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    const source = await context.newPage(), target = await context.newPage()
    await source.goto(`${portal.baseUrl}/transfer-demo/source`); await target.goto(`${portal.baseUrl}/transfer-demo/marketplace`)
    const [sourceId, targetId] = await extensionPage.evaluate(async (origin) => Promise.all(["source", "marketplace"].map(async (path) =>
      (await chrome.tabs.query({ url: `${origin}/transfer-demo/${path}` }))[0].id!)), portal.baseUrl)
    await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId } })
    const initial = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: [targetId] } })
    const profile = await saveProfile(initial, "Portable fixture", { "System Beta Marketplace Portal": {
      "Registered business": { source: "Legal company name" }, "Operations email": { source: "Contact email" },
    } })
    const content = await request<string>({ type: "PERSONAL_EXPORT_PROFILE", profileId: profile.id })
    expect(content).not.toContain("Example Commerce Group Pty Ltd")
    expect(content).not.toContain("operations@example.com")
    expect(content).not.toContain("CUST-DEMO-001")
    const adminPromise = context.waitForEvent("page")
    await extensionPage.getByRole("button", { name: "Open RekeyZero Admin" }).click()
    const admin = await adminPromise; await admin.waitForLoadState("domcontentloaded")
    await admin.locator(".profile-list > div", { hasText: "Portable fixture" }).getByRole("button", { name: "Open" }).click()
    const downloadPromise = admin.waitForEvent("download")
    await admin.getByRole("button", { name: "Export Profile", exact: true }).click()
    expect((await downloadPromise).suggestedFilename()).toContain("rekeyzero-profile")
    const input = JSON.parse(content); input.profile.name = "Imported fixture"
    await admin.getByLabel("Import Profile", { exact: true }).setInputFiles({ name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(input)) })
    await expect(admin.getByRole("heading", { name: "Review Profile import" })).toBeVisible()
    expect((await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } })).length).toBe(1)
    await admin.getByRole("button", { name: "Import as new Profile" }).click()
    await expect(admin.getByText(/Profile imported as a new copy/)).toBeVisible()
    const saved = await request<MappingProfile[]>({ type: "TRANSFER", command: { type: "GET_MAPPING_PROFILES" } })
    const imported = saved.find((item) => item.name === "Imported fixture")!
    expect(imported.id).not.toBe(profile.id)
    await expect(extensionPage.getByLabel("Transfer Profile", { exact: true }).locator(`option[value="${imported.id}"]`)).toHaveText("Imported fixture")
    await request({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: imported.id } })
    await request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })
    await expect(target.getByLabel("Registered business")).toHaveValue("Example Commerce Group Pty Ltd")
    await expect.poll(async () => (await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).status).not.toBe("running")
    for (const item of saved) await request({ type: "TRANSFER", command: { type: "DELETE_MAPPING_PROFILE", profileId: item.id } })
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    await Promise.all([source.close(), target.close(), admin.close()])
  })


  test("uses the checked-in synthetic Profile examples against real fixture controls", async () => {
    const source = await context.newPage(); await source.goto(`${portal.baseUrl}/transfer-demo/source`)
    const sourceId = await extensionPage.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/transfer-demo/source` }))[0].id!, portal.baseUrl)
    for (const name of ["marketplace", "fulfilment"]) {
      await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
      const target = await context.newPage(); await target.goto(`${portal.baseUrl}/transfer-demo/${name}`)
      const targetId = await extensionPage.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id!, `${portal.baseUrl}/transfer-demo/${name}`)
      await request({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId } })
      const state = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: [targetId] } })
      const content = JSON.parse(readFileSync(join(import.meta.dirname, `../../../examples/profiles/synthetic-${name}.json`), "utf8"))
      for (const [baseline, observed] of [[content.profile.source, state.source!], [content.profile.targets[0], state.targets[0].observation!]] as const) {
        expect(baseline.fields.map((field: { templateKey: string }) => field.templateKey).sort()).toEqual(observed.fields.map((field) => field.templateKey).sort())
        const expectedHash = createHash("sha256").update(JSON.stringify([baseline.origin,
          observed.fields.map((field) => [field.templateKey, field.type]).sort((a, b) => a[0].localeCompare(b[0])),
        ])).digest("hex")
        expect(baseline.template).toBe(expectedHash)
        // The E2E fixture uses an ephemeral port; examples retain their documented default port.
        baseline.origin = portal.baseUrl; baseline.template = observed.template
      }
      const home = await request<{ profiles: MappingProfile[] }>({ type: "PERSONAL_IMPORT_PROFILE", content: JSON.stringify(content) })
      const profile = home.profiles.find((item) => item.name === content.profile.name)!
      const prepared = await request<Session>({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: profile.id } })
      expect(prepared.profileDrift).toBeUndefined()
      await request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })
      await expect(target.getByLabel(name === "marketplace" ? "Operations email" : "Contact email")).toHaveValue("operations@example.com")
      await expect.poll(async () => (await request<Session>({ type: "TRANSFER", command: { type: "GET_TRANSFER" } })).status).not.toBe("running")
      if (name === "fulfilment") await expect(target.getByLabel("Legal company name")).toHaveValue("Existing draft merchant")
      await request({ type: "TRANSFER", command: { type: "DELETE_MAPPING_PROFILE", profileId: profile.id } })
      await target.close()
    }
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } }); await source.close()
  })

  test("saves and reuses a late large-form section without observing other section values", async () => {
    await request({ type: "TRANSFER", command: { type: "RESET_TRANSFER" } })
    const source = await context.newPage()
    const target = await context.newPage()
    await source.goto(`${portal.baseUrl}/section-form`)
    await target.goto(`${portal.baseUrl}/section-form`)
    await source.getByLabel("Claims field 80", { exact: true }).fill("Reviewed claim")
    await source.locator("input").evaluateAll((inputs) => inputs.forEach((input) => { (input as HTMLInputElement).readOnly = true }))
    const [sourceId, targetId] = await extensionPage.evaluate(async (source) => {
      const tabs = await chrome.tabs.query({})
      const matching = tabs.filter((tab) => tab.url === source)
      return matching.map((tab) => tab.id!)
    }, source.url())
    let state = await request<Session>({ type: "TRANSFER", command: { type: "SET_SOURCE", tabId: sourceId, group: "Claims" } })
    expect(state.source!.fields).toHaveLength(80)
    expect(state.source!.truncated).toBe(false)
    state = await request<Session>({ type: "TRANSFER", command: { type: "ADD_TARGETS", tabIds: [targetId] } })
    state = await request<Session>({ type: "TRANSFER", command: { type: "SET_TARGET_GROUPS", targetId: state.targets[0].id, groups: ["Claims"] } })
    const profile = await saveProfile(state, "Claims section only", { "Section form": { "Claims field 80": { source: "Claims field 80" } } })
    expect(profile.source.selectedGroups).toEqual(["Claims"])
    expect(profile.targets[0].selectedGroups).toEqual(["Claims"])
    const exported = await request<string>({ type: "PERSONAL_EXPORT_PROFILE", profileId: profile.id })
    expect(JSON.parse(exported).minimumExtensionVersion).toBe("0.3.0")
    await extensionPage.evaluate(async (tabId) => chrome.tabs.update(tabId, { active: true }), sourceId)
    await request({ type: "TRANSFER", command: { type: "USE_MAPPING_PROFILE", profileId: profile.id } })
    await request({ type: "TRANSFER", command: { type: "RUN_TRANSFER" } })
    await expect(target.getByLabel("Claims field 80", { exact: true })).toHaveValue("Reviewed claim")
    await expect(target.getByLabel("Insured field 1", { exact: true })).toHaveValue("")
    await Promise.all([source.close(), target.close()])
  })

})
