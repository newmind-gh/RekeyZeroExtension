import { strFromU8, unzipSync } from "fflate"
import type { ParsedDocument } from "./source-prepare-session"

export async function parseDocx(file: File): Promise<ParsedDocument["pages"]> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
    if (entry.name !== "word/document.xml") return false
    if (entry.originalSize > 2 * 1024 * 1024) throw new Error("This document is too large for Source Preparation")
    return true
  } })
  const document = entries["word/document.xml"]
  if (!document) throw new Error("Could not read this document")
  const xml = strFromU8(document)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Could not read this document")
  const parsed = new DOMParser().parseFromString(xml, "application/xml")
  if (parsed.getElementsByTagName("parsererror").length) throw new Error("Could not read this document")
  // Paragraphs also include table cells. Only text nodes enter the evidence text.
  const text = Array.from(parsed.getElementsByTagNameNS("*", "p")).map((paragraph) =>
    Array.from(paragraph.getElementsByTagNameNS("*", "t")).map((node) => node.textContent ?? "").join(""),
  ).filter(Boolean).join("\n")
  return [{ text }]
}
