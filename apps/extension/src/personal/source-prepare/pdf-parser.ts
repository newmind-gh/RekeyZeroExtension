import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import { MAX_DOCUMENT_CHARACTERS } from "./document-parser"
import type { ParsedDocument } from "./source-prepare-session"

GlobalWorkerOptions.workerSrc = workerUrl
export async function parsePdf(file: File): Promise<ParsedDocument["pages"]> {
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const pdf = await task.promise
        if (pdf.numPages > 200) throw new Error("This document is too large for Source Preparation")
        const pages: ParsedDocument["pages"] = []
        let characters = 0
        for (let page = 1; page <= pdf.numPages; page++) {
          const current = await pdf.getPage(page)
          const content = await current.getTextContent()
          const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim()
          characters += text.length
          if (characters > MAX_DOCUMENT_CHARACTERS) throw new Error("This document is too large for Source Preparation")
          pages.push({ page, text })
          current.cleanup()
        }
        if (!pages.some((page) => page.text.trim())) throw new Error("No readable text was found in this document. Scanned PDFs require OCR and are not supported.")
        return pages
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Could not read this document")), 20_000) }),
    ])
  } finally { clearTimeout(timer); await task.destroy() }
}
