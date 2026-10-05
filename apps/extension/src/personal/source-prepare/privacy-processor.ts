import type { PrivacyResult } from "./source-prepare-session"

export const PRIVACY_PROCESSING_ERROR = "Privacy processing could not complete. The document was not sent to the AI provider."
export async function processPrivacy(markdown: string): Promise<PrivacyResult> {
  try {
    const { tier0Spans, mergeSpans, toSpans, buildEntityMap, redactedText, labelMeta } = await import("@ossredact/core")
    // Use the library's standard Tier-0 rules, overlap handling and placeholders.
    // The temporary entity map supplies placeholder previews only; never restore,
    // retain or send its raw values to the external provider.
    const spans = toSpans(mergeSpans(tier0Spans(markdown)), "auto")
    const { placeholderOf, index } = buildEntityMap(markdown, spans)
    return { redactedMarkdown: redactedText(markdown, spans, index),
      findings: spans.map((span) => ({ type: span.label, displayName: labelMeta(span.label).en, placeholder: placeholderOf.get(span.id)! })) }
  } catch { throw new Error(PRIVACY_PROCESSING_ERROR) }
}
