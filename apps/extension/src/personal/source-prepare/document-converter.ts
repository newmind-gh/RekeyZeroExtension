import { hash } from "../../transfer/planner"
import type { ConvertedDocument, PreparedDocument } from "./source-prepare-session"
import { processPrivacy, PRIVACY_PROCESSING_ERROR } from "./privacy-processor"

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_CHARACTERS = 80_000
export const MAX_SOURCE_DOCUMENTS = 6
export const SOURCE_DOCUMENT_ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.html,.htm,.csv,.eml"
const extensions = new Set(SOURCE_DOCUMENT_ACCEPT.split(",").map((extension) => extension.slice(1)).concat("msg"))
export const SCANNED_PDF_ERROR = "This PDF appears to be scanned or image-only. Scanned PDFs are not supported yet."
const CONVERSION_ERROR = "This document could not be converted to text."
const LARGE_DOCUMENT_ERROR = "These documents are too large for Source Preparation (80,000 characters maximum)"
let converter: Promise<typeof import("docling.rs-wasm/web")> | undefined
async function loadConverter() {
  converter ??= (async () => {
    const [module, asset] = await Promise.all([
      import("docling.rs-wasm/web"), import("docling.rs-wasm/web/docling_wasm_bg.wasm?url"),
    ])
    await module.default({ module_or_path: asset.default })
    return module
  })().catch((error: unknown) => { converter = undefined; throw error })
  return converter
}
export async function convertSourceDocument(file: File): Promise<ConvertedDocument> {
  if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error("Source documents must be between 1 byte and 10 MB")
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? ""
  const converterExtension = extension === "markdown" ? "md" : extension
  if (!extensions.has(extension)) throw new Error("Unsupported document format.")
  let markdown: string
  try {
    const module = await loadConverter()
    const supported: string[] = JSON.parse(module.supported_extensions())
    if (!supported.includes(converterExtension)) throw new Error("Unsupported document format.")
    // Only the digital convert API runs. Never initialize OCR, layout, models,
    // image rendering, remote image fetches, or the package's browser pipeline.
    markdown = module.convert(new Uint8Array(await file.arrayBuffer()), `document.${converterExtension}`, "md", "placeholder")
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "Unsupported document format.") throw new Error(message)
    if (extension === "pdf" && /no (?:embedded )?text layer|no (?:usable|extractable) text|scanned|image.only|OCR/i.test(message)) {
      // Confirmed compatibility issue in 1.93.5: valid text PDFs can be rejected
      // as missing a text layer. Retain the existing local PDF.js text reader.
      try { markdown = await (await import("./pdf-parser")).parsePdf(file) }
      catch (fallbackError) {
        if (fallbackError instanceof Error && fallbackError.message === SCANNED_PDF_ERROR) throw new Error(SCANNED_PDF_ERROR)
        throw new Error(CONVERSION_ERROR)
      }
    } else throw new Error(CONVERSION_ERROR)
  }
  if (!markdown.trim()) throw new Error(extension === "pdf" ? SCANNED_PDF_ERROR : CONVERSION_ERROR)
  if (markdown.length > MAX_DOCUMENT_CHARACTERS) throw new Error(LARGE_DOCUMENT_ERROR)
  return { id: crypto.randomUUID(), name: file.name.slice(0, 240), mediaType: file.type || "application/octet-stream", size: file.size, markdown }
}
export async function prepareSourceDocument(file: File): Promise<PreparedDocument> {
  const document = await convertSourceDocument(file)
  const privacy = await processPrivacy(document.markdown)
  const prepared = { ...document, privacy, textHash: await hash(privacy.redactedMarkdown) }
  validatePreparedDocuments([prepared])
  return prepared
}
export function validatePreparedDocuments(input: unknown): asserts input is PreparedDocument[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_SOURCE_DOCUMENTS) throw new Error("Add between 1 and 6 source documents")
  const ids = new Set<string>()
  let characters = 0
  for (const document of input) {
    if (!document || typeof document !== "object" || typeof document.id !== "string" || !document.id || document.id.length > 100
      || ids.has(document.id) || typeof document.name !== "string" || !document.name.trim() || document.name.length > 240
      || typeof document.mediaType !== "string" || document.mediaType.length > 120 || !Number.isInteger(document.size) || document.size <= 0 || document.size > MAX_DOCUMENT_BYTES
      || typeof document.markdown !== "string" || !document.markdown.trim()
      || typeof document.textHash !== "string" || !/^[a-f0-9]{64}$/.test(document.textHash)) throw new Error(CONVERSION_ERROR)
    ids.add(document.id)
    const privacy = document.privacy
    if (!privacy || typeof privacy.redactedMarkdown !== "string" || !privacy.redactedMarkdown.trim() || !Array.isArray(privacy.findings)
      || privacy.findings.some((finding: unknown) => !finding || typeof finding !== "object" || !("type" in finding) || typeof finding.type !== "string"
        || !("displayName" in finding) || typeof finding.displayName !== "string"
        || !("placeholder" in finding) || typeof finding.placeholder !== "string" || !finding.placeholder)) throw new Error(PRIVACY_PROCESSING_ERROR)
    characters += Math.max(document.markdown.length, privacy.redactedMarkdown.length)
    if (characters > MAX_DOCUMENT_CHARACTERS) throw new Error(LARGE_DOCUMENT_ERROR)
  }
}
