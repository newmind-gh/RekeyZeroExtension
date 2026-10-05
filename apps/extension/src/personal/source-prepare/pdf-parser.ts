import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import { MAX_DOCUMENT_CHARACTERS, SCANNED_PDF_ERROR } from "./document-converter"

GlobalWorkerOptions.workerSrc = workerUrl
// Compatibility fallback for text PDFs rejected by the installed Docling WASM.
// PDF.js reads only the embedded text layer; it never runs OCR or renders images.
export async function parsePdf(file: File): Promise<string> {
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const pdf = await task.promise
        if (pdf.numPages > 200) throw new Error("This document is too large for Source Preparation")
        const pages: string[] = []
        let characters = 0
        for (let page = 1; page <= pdf.numPages; page++) {
          const current = await pdf.getPage(page)
          const content = await current.getTextContent()
          const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim()
          characters += text.length
          if (characters > MAX_DOCUMENT_CHARACTERS) throw new Error("This document is too large for Source Preparation")
          pages.push(text)
          current.cleanup()
        }
        if (!pages.some((page) => page.trim())) throw new Error(SCANNED_PDF_ERROR)
        return pages.join("\n\n")
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Could not read this document")), 20_000) }),
    ])
  } finally { clearTimeout(timer); await task.destroy() }
}
