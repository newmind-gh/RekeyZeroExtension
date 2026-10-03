import marketplaceExample from "../../../../examples/profiles/synthetic-marketplace.json"
import fulfilmentExample from "../../../../examples/profiles/synthetic-fulfilment.json"
import { describe, expect, it } from "vitest"
import { exportMappingProfile, importMappingProfile } from "./profile-portability"
import type { MappingProfile } from "./types"

const profile: MappingProfile = {
  id: "local-id", name: "Synthetic profile", version: 2, revision: 3,
  source: { origin: "https://source.example.test", pathPattern: "/:segment", template: "source-hash", title: "Source",
    fields: [{ templateKey: "source-field", identityKey: "source-identity", type: "text", label: "Company" }] },
  targets: [{ id: "local-target", origin: "https://target.example.test", pathPattern: "/:segment", template: "target-hash", title: "Target",
    fields: [{ templateKey: "target-field", identityKey: "target-identity", type: "text", label: "Business" }],
    mappings: [{ sourceTemplateKey: "source-field", targetTemplateKey: "target-field", existingValuePolicy: "blank_only" }] }],
  createdAt: "2026-01-01", updatedAt: "2026-01-02",
}
const payload = () => JSON.parse(exportMappingProfile(profile))

describe("Portable Mapping Profiles", () => {
  it("round-trips metadata and policy with fresh IDs and no local runtime state", () => {
    const serialized = exportMappingProfile({ ...profile, value: "PRIVATE", apiKey: "SECRET" } as MappingProfile)
    expect(serialized).not.toContain("PRIVATE"); expect(serialized).not.toContain("SECRET")
    expect(serialized).not.toContain("local-id"); expect(serialized).not.toContain("local-target")
    const imported = importMappingProfile(serialized, "0.2.0")
    expect(imported).toMatchObject({ name: profile.name, version: 2, revision: 3, source: profile.source })
    expect(imported.targets[0].mappings).toEqual(profile.targets[0].mappings)
    expect(imported.id).not.toBe(profile.id)
    expect(importMappingProfile(serialized, "0.2.0").id).not.toBe(imported.id)
  })

  it.each(["value", "current_value", "apiKey", "selectors", "script"])("rejects unexpected %s at every nested boundary", (key) => {
    for (const location of ["envelope", "profile", "source", "field", "target", "mapping"]) {
      const input = payload()
      const node = location === "envelope" ? input : location === "profile" ? input.profile : location === "source" ? input.profile.source
        : location === "field" ? input.profile.source.fields[0] : location === "target" ? input.profile.targets[0] : input.profile.targets[0].mappings[0]
      node[key] = "PRIVATE"
      expect(() => importMappingProfile(JSON.stringify(input), "0.2.0")).toThrow("unsupported properties")
    }
  })

  it("rejects incompatible schemas, versions, origins, paths, policy and oversized files", () => {
    const mutations = [
      (input: any) => { input.schemaVersion = 2 },
      (input: any) => { input.minimumExtensionVersion = "99.0.0" },
      (input: any) => { input.profile.source.origin = "https://user:password@source.example.test" },
      (input: any) => { input.profile.source.origin = "http://source.example.test" },
      (input: any) => { input.profile.source.pathPattern = "/customers/PRIVATE" },
      (input: any) => { input.profile.targets[0].mappings[0].existingValuePolicy = "submit" },
      (input: any) => { input.profile.targets[0].mappings.push(input.profile.targets[0].mappings[0]) },
      (input: any) => { input.profile.targets[0].mappings[0].sourceTemplateKey = "unknown" },
    ]
    for (const mutate of mutations) {
      const input = payload(); mutate(input)
      expect(() => importMappingProfile(JSON.stringify(input), "0.2.0")).toThrow()
    }
    expect(() => importMappingProfile(" ".repeat(1_000_001), "0.2.0")).toThrow("exceeds")
    expect(() => importMappingProfile(exportMappingProfile(profile), "0.1.0")).toThrow("requires")
  })

  it.each([["marketplace", marketplaceExample], ["fulfilment", fulfilmentExample]])("imports the checked-in synthetic %s example", (_name, example) => {
    const content = JSON.stringify(example)
    const imported = importMappingProfile(content, "0.2.0")
    expect(imported.targets[0].mappings).toHaveLength(6)
    expect(imported.source.origin).toBe("http://127.0.0.1:4178")
    expect(content).not.toContain("operations@example.com")
    expect(content).not.toContain("Example Commerce Group")
  })

})
