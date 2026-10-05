import { hash } from "../../transfer/planner"
import type { ParsedDocument } from "./source-prepare-session"

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_CHARACTERS = 80_000
export const MAX_SOURCE_DOCUMENTS = 6
export function validateParsedDocuments(input: unknown): asserts input is ParsedDocument[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_SOURCE_DOCUMENTS) throw new Error("Add between 1 and 6 source documents")
  const ids = new Set<string>()
  let characters = 0
  for (const document of input) {
    if (!document || typeof document !== "object" || typeof document.id !== "string" || !document.id || document.id.length > 100
      || ids.has(document.id) || typeof document.name !== "string" || !document.name.trim() || document.name.length > 240
      || typeof document.mediaType !== "string" || document.mediaType.length > 120 || !Number.isInteger(document.size) || document.size < 0 || document.size > MAX_DOCUMENT_BYTES
      || typeof document.textHash !== "string" || !/^[a-f0-9]{64}$/.test(document.textHash)
      || !Array.isArray(document.pages) || !document.pages.length || document.pages.length > 200) throw new Error("Could not read this document")
    ids.add(document.id)
    let readable = false
    const pages = new Set<number>()
    for (const page of document.pages) {
      if (!page || typeof page.text !== "string" || (page.page !== undefined && (!Number.isInteger(page.page) || page.page < 1 || pages.has(page.page)))) throw new Error("Could not read this document")
      if (page.page !== undefined) pages.add(page.page)
      characters += page.text.length
      readable ||= Boolean(page.text.trim())
    }
    if (!readable) throw new Error("No readable text was found in this document")
    if (characters > MAX_DOCUMENT_CHARACTERS) throw new Error("These documents are too large for Source Preparation (80,000 characters maximum)")
  }
}
export async function parseSourceDocument(file: File): Promise<ParsedDocument> {
  if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error("Source documents must be between 1 byte and 10 MB")
  const extension = file.name.split(".").at(-1)?.toLowerCase()
  let pages: ParsedDocument["pages"]
  try {
    if (["txt", "md", "markdown"].includes(extension ?? "")) pages = [{ text: await file.text() }]
    else if (extension === "pdf") pages = await (await import("./pdf-parser")).parsePdf(file)
    else if (extension === "docx") pages = await (await import("./docx-parser")).parseDocx(file)
    else throw new Error("Use TXT, Markdown, text-based PDF, or DOCX documents")
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/^(Use TXT|No readable text|This document is too large)/.test(message)) throw error
    throw new Error("Could not read this document")
  }
  const document: ParsedDocument = {
    id: crypto.randomUUID(), name: file.name.slice(0, 240), mediaType: file.type || "application/octet-stream",
    size: file.size, textHash: await hash(pages), pages,
  }
  validateParsedDocuments([document])
  return document
}
