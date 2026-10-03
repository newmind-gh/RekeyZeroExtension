import type { MappingProfile, ProfileFieldTemplate, ProfilePageTemplate, ProfileTargetTemplate } from "./types"

export const PROFILE_FILE_LIMIT_BYTES = 1_000_000
const MINIMUM_EXTENSION_VERSION = "0.2.0"
const policies = ["blank_only", "overwrite", "skip"] as const

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Profile JSON object")
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new Error("Profile contains unsupported properties or runtime values")
  return result
}
function text(value: unknown, name: string, maximum = 2048, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid Profile ${name}`)
  }
  return value
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Profile array is invalid or too large")
  return value
}
function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid Profile revision")
  return value as number
}
function page(value: unknown, target = false): ProfilePageTemplate {
  const input = object(value, ["origin", "pathPattern", "template", "title", "fields", "selectedGroups", ...(target ? ["mappings"] : [])])
  const origin = text(input.origin, "origin")
  const url = new URL(origin)
  if (url.origin !== origin || url.username || url.password || !(url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Unsupported Profile origin")
  const pathPattern = text(input.pathPattern, "path pattern")
  if (!/^\/(?:\:segment(?:\/\:segment)*)?$/.test(pathPattern)) throw new Error("Profile path must contain only a value-free path shape")
  const fields: ProfileFieldTemplate[] | undefined = input.fields === undefined ? undefined : list(input.fields, 120).map((value) => {
    const field = object(value, ["templateKey", "identityKey", "type", "label"])
    return { templateKey: text(field.templateKey, "field key"), type: text(field.type, "control type", 64),
      label: text(field.label, "field label", 2048, true),
      ...(field.identityKey === undefined ? {} : { identityKey: text(field.identityKey, "field identity") }) }
  })
  const selectedGroups = input.selectedGroups === undefined ? undefined : list(input.selectedGroups, 32).map((value) => text(value, "section", 2048, true))
  if (selectedGroups && new Set(selectedGroups).size !== selectedGroups.length) throw new Error("Duplicate section scope")
  if (selectedGroups?.some((group) => /Record |Row /.test(group))) throw new Error("Record-specific groups cannot be exported as section scopes")
  return { ...(selectedGroups?.length ? { selectedGroups } : {}), origin, pathPattern, template: text(input.template, "template hash", 256), title: text(input.title, "title"),
    ...(fields ? { fields } : {}) }
}

function portablePage(input: ProfilePageTemplate): ProfilePageTemplate {
  return { ...(input.selectedGroups?.length ? { selectedGroups: [...input.selectedGroups] } : {}), origin: input.origin, pathPattern: input.pathPattern, template: input.template, title: input.title,
    ...(input.fields ? { fields: input.fields.map(({ templateKey, identityKey, type, label }) => ({
      templateKey, type, label, ...(identityKey ? { identityKey } : {}),
    })) } : {}) }
}

export function exportMappingProfile(profile: MappingProfile): string {
  const payload = {
    format: "rekeyzero-mapping-profile", schemaVersion: 1, minimumExtensionVersion: profile.source.selectedGroups?.length || profile.targets.some((target) => target.selectedGroups?.length) ? "0.3.0" : MINIMUM_EXTENSION_VERSION,
    profile: {
      name: profile.name, kind: profile.kind ?? "profile", version: profile.version, revision: profile.revision ?? 1,
      source: portablePage(profile.source),
      targets: profile.targets.map((target) => ({ ...portablePage(target), mappings: target.mappings.map((mapping) => ({
        sourceTemplateKey: mapping.sourceTemplateKey, targetTemplateKey: mapping.targetTemplateKey,
        existingValuePolicy: mapping.existingValuePolicy,
      })) })),
    },
  }
  const serialized = JSON.stringify(payload, null, 2)
  // Validate even exports so malformed local records cannot become shareable profiles.
  importMappingProfile(serialized, "0.3.0")
  return serialized
}

export function importMappingProfile(content: string, extensionVersion: string): MappingProfile {
  if (new TextEncoder().encode(content).byteLength > PROFILE_FILE_LIMIT_BYTES) throw new Error("Profile file exceeds 1 MB")
  const envelope = object(JSON.parse(content) as unknown, ["format", "schemaVersion", "minimumExtensionVersion", "profile"])
  if (envelope.format !== "rekeyzero-mapping-profile" || envelope.schemaVersion !== 1) throw new Error("Unsupported Profile file schema")
  const minimum = text(envelope.minimumExtensionVersion, "minimum extension version", 32)
  if (!/^\d+\.\d+\.\d+$/.test(minimum) || !/^\d+\.\d+\.\d+$/.test(extensionVersion)) throw new Error("Invalid extension version")
  const required = minimum.split(".").map(Number), installed = extensionVersion.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    if (installed[index] > required[index]) break
    if (installed[index] < required[index]) throw new Error(`Profile requires RekeyZero ${minimum} or newer`)
  }
  const input = object(envelope.profile, ["name", "kind", "version", "revision", "source", "targets"])
  if (input.version !== 1 && input.version !== 2) throw new Error("Unsupported Mapping Profile version")
  if (input.kind !== "profile" && input.kind !== "ai_fill_setup") throw new Error("Invalid Profile kind")
  const source = page(input.source)
  const targets: ProfileTargetTemplate[] = list(input.targets, 20).map((value) => {
    const target = page(value, true)
    const mappings = list((value as Record<string, unknown>).mappings, 120).map((value) => {
      const mapping = object(value, ["sourceTemplateKey", "targetTemplateKey", "existingValuePolicy"])
      if (!policies.includes(mapping.existingValuePolicy as typeof policies[number])) throw new Error("Invalid existing-value policy")
      const policy = mapping.existingValuePolicy as typeof policies[number]
      const sourceTemplateKey = text(mapping.sourceTemplateKey, "source field key", 2048, policy === "skip")
      const targetTemplateKey = text(mapping.targetTemplateKey, "target field key")
      if (target.fields && !target.fields.some((field) => field.templateKey === targetTemplateKey)) throw new Error("Mapping target is outside the Profile template")
      if (policy !== "skip" && source.fields && !source.fields.some((field) => field.templateKey === sourceTemplateKey)) throw new Error("Mapping source is outside the Profile template")
      return { sourceTemplateKey, targetTemplateKey, existingValuePolicy: policy }
    })
    if (new Set(mappings.map((mapping) => mapping.targetTemplateKey)).size !== mappings.length) throw new Error("Duplicate target mapping")
    return { ...target, id: crypto.randomUUID(), mappings }
  })
  if (!targets.length) throw new Error("Profile needs at least one target")
  if (new Set(targets.map((target) => `${target.origin}|${target.pathPattern}|${target.template}`)).size !== targets.length) throw new Error("Duplicate target page template")
  if (input.version === 2 && (!source.fields?.length || targets.some((target) => !target.fields?.length))) throw new Error("Profile v2 needs field baselines")
  const now = new Date().toISOString()
  return { id: crypto.randomUUID(), name: text(input.name, "name", 200).trim(), kind: input.kind,
    version: input.version, revision: positiveInteger(input.revision), source, targets, createdAt: now, updatedAt: now }
}
