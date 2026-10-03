import { describe, expect, it, vi } from "vitest"

import { removeHostPermissionIfUnused } from "./host-permissions"

describe("Personal optional host permissions", () => {
  it("removes an origin when no provider or Mapping Profile still needs it", async () => {
    const remove = vi.fn(async () => true)
    vi.stubGlobal("chrome", { permissions: { remove } })

    expect(await removeHostPermissionIfUnused({
      origin: "https://unused.example.test/v1",
      providerOrigins: [],
      profiles: [],
    })).toBe(true)
    expect(remove).toHaveBeenCalledWith({ origins: ["https://unused.example.test/*"] })
  })

  it("retains a configured direct-provider origin", async () => {
    const remove = vi.fn(async () => true)
    vi.stubGlobal("chrome", { permissions: { remove } })
    expect(await removeHostPermissionIfUnused({
      origin: "https://shared.example.test",
      providerOrigins: ["https://shared.example.test"],
      profiles: [],
    })).toBe(false)
    expect(remove).not.toHaveBeenCalled()

    expect(await removeHostPermissionIfUnused({
      origin: "https://shared.example.test",
      providerOrigins: [],
      profiles: [],
    })).toBe(true)
    expect(remove).toHaveBeenCalledWith({ origins: ["https://shared.example.test/*"] })
  })

  it("retains profile origins and removes an origin after its last profile is deleted", async () => {
    const remove = vi.fn(async () => true)
    vi.stubGlobal("chrome", { permissions: { remove } })
    const profile = {
      id: "profile",
      name: "Profile",
      version: 1 as const,
      source: { origin: "https://source.example.test", pathPattern: "/:segment", template: "source", title: "Source" },
      targets: [{ id: "target", origin: "https://target.example.test", pathPattern: "/:segment", template: "target", title: "Target", mappings: [] }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }

    expect(await removeHostPermissionIfUnused({
      origin: "https://target.example.test/form",
      providerOrigins: [],
      profiles: [profile],
    })).toBe(false)
    expect(remove).not.toHaveBeenCalled()

    expect(await removeHostPermissionIfUnused({
      origin: "https://target.example.test/form",
      providerOrigins: [],
      profiles: [],
    })).toBe(true)
    expect(remove).toHaveBeenCalledWith({ origins: ["https://target.example.test/*"] })
  })
})
