import { AnonymizationSession, ENTITY_LABELS, GlinerProvider, GLINER_MODEL_URL, GLINER_TOKENIZER_FILES,
  detectWithRegex, filterFalsePositives, memoryKV, resolveOverlaps } from "@doccloak/core"
import type { CoreEnv, DetectedEntity, EntityType } from "@doccloak/core"
import { Tokenizer } from "@huggingface/tokenizers"
import type { PrivacyResult } from "./source-prepare-session"
import { detectAustralianIdentifiers } from "./australian-identifiers"

export const PRIVACY_MODEL_CACHE = "rekeyzero-privacy-models-v2"
// Configuration of upstream entity types, not a separate PII definition set.
export const ENABLED_PRIVACY_TYPES: ReadonlySet<EntityType> = new Set([
  "PERSON", "ADDRESS", "EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IBAN", "IP_ADDRESS", "SECRET", "API_KEY",
])
function enabled(entity: DetectedEntity): boolean {
  return ENABLED_PRIVACY_TYPES.has(entity.type) && entity.detector !== "gliner:city" && entity.detector !== "gliner:zip code"
}
export function redactPrivacyEntities(markdown: string, semantic: DetectedEntity[]): PrivacyResult {
  for (const entity of semantic) {
    if (!entity || typeof entity.type !== "string" || typeof entity.detector !== "string"
      || !Object.hasOwn(ENTITY_LABELS, entity.type) || !Number.isFinite(entity.confidence) || entity.confidence < 0 || entity.confidence > 1
      || !Number.isInteger(entity.start) || !Number.isInteger(entity.end)
      || entity.start < 0 || entity.end <= entity.start || entity.end > markdown.length
      || markdown.slice(entity.start, entity.end) !== entity.value) throw new Error("Invalid privacy result")
  }
  // The upstream labeled session accepts string entity IDs at runtime. Its
  // declaration lists built-in types only; extend that boundary for AU IDs.
  const australian = detectAustralianIdentifiers(markdown).map((span) => ({ ...span,
    type: span.type as EntityType, value: markdown.slice(span.start, span.end), confidence: 1, detector: "au:validated",
  }))
  // Apply policy before upstream overlap resolution. Generic dates, companies,
  // money and standalone geographic labels do not trigger redaction.
  const general = resolveOverlaps([
    ...filterFalsePositives(semantic.filter(enabled)),
    // Physical/postal addresses use semantic detection. Generic regional
    // postal-code rules can consume business years and the following heading.
    ...detectWithRegex(markdown).filter((entity) => enabled(entity) && entity.type !== "ADDRESS"),
  ])
  // Preserve the coverage of overlapping general spans while assigning the
  // validated Australian portion its more specific upstream placeholder type.
  const remaining = general.flatMap((entity) => {
    let parts = [entity]
    for (const au of australian) {
      parts = parts.flatMap((part) => {
        if (part.end <= au.start || part.start >= au.end) return [part]
        const ranges = [[part.start, Math.min(part.end, au.start)], [Math.max(part.start, au.end), part.end]]
        return ranges.filter(([start, end]) => end > start).map(([start, end]) => ({
          ...part, start, end, value: markdown.slice(start, end),
        }))
      })
    }
    return parts
  })
  const entities = resolveOverlaps([...australian, ...remaining])
  for (const entity of entities) {
    if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end) || entity.start < 0 || entity.end <= entity.start
      || entity.end > markdown.length || markdown.slice(entity.start, entity.end) !== entity.value) throw new Error("Invalid privacy result")
  }
  const session = new AnonymizationSession({ mode: "labeled" })
  try {
    const redactedMarkdown = session.anonymizeText(markdown, entities)
    const entries = session.getEntries().filter(({ replacement }) => redactedMarkdown.includes(replacement))
    const entityMap = Object.fromEntries(entries.map(({ replacement, original }) => [replacement, original]))
    const findings = entries.map(({ entityType, replacement }) => ({
      type: entityType, displayName: ENTITY_LABELS[entityType] ?? entityType.replace("AU_", ""), placeholder: replacement,
    }))
    return { redactedMarkdown, findings, entityMap }
  } finally { session.clear() }
}
export function createPrivacyEngine(wasmPaths: string, onProgress: (message: string) => void = () => {}) {
  const urls = new Set([GLINER_MODEL_URL, ...GLINER_TOKENIZER_FILES.map((file) => file.url)])
  const env: CoreEnv = {
    kv: memoryKV(),
    modelCache: {
      async match(url) { return (await (await caches.open(PRIVACY_MODEL_CACHE)).match(url))?.blob() },
      async put(url, blob) { try { await (await caches.open(PRIVACY_MODEL_CACHE)).put(url, new Response(blob)); return true } catch { return false } },
      async delete(url) { await (await caches.open(PRIVACY_MODEL_CACHE)).delete(url) },
    },
    fetch: (input, init) => {
      const request = new Request(input, init)
      if (!urls.has(request.url) || request.method !== "GET" || request.body) throw new Error("Unsupported privacy asset request")
      return fetch(request, { credentials: "omit", referrerPolicy: "no-referrer" })
    },
    wasm: { paths: wasmPaths, numThreads: 1 },
    buildTokenizer: (json, config) => {
      const tokenizer = new Tokenizer(json as never, config as never)
      return { encode: (text: string) => tokenizer.encode(text).ids }
    },
  }
  const provider = new GlinerProvider(env)
  // The compatibility patch exposes only label configuration, leaving all
  // upstream tokenization, inference and span decoding unchanged.
  provider.setEnabledLabels(["person name", "street address"])
  provider.onProgress(() => onProgress("Loading verified local privacy model…"))
  let initialized: Promise<void> | undefined
  return {
    async process(markdown: string): Promise<PrivacyResult> {
      initialized ??= provider.load().catch((error: unknown) => { provider.release(); initialized = undefined; throw error })
      await initialized
      onProgress("Checking privacy locally…")
      const entities = await provider.detect(markdown)
      if (!Array.isArray(entities)) throw new Error("Invalid privacy result")
      return redactPrivacyEntities(markdown, entities)
    },
  }
}
