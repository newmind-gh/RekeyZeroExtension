export type PrivacyFinding = { type: string; displayName: string; placeholder: string }
export type PrivacyEntityMap = Record<string, string>
export type PrivacyResult = { findings: PrivacyFinding[]; redactedMarkdown: string; entityMap: PrivacyEntityMap }

// Accept upstream person-variant suffixes, but never repair provider spelling.
export const PRIVACY_PLACEHOLDER = /^\[([A-Z][A-Z_]*?)_([1-9]\d*)(?:_[A-Z]+(?:_[1-9]\d*)?)?\]$/
export function validPrivacyResult(input: unknown): input is PrivacyResult {
  if (!input || typeof input !== "object") return false
  const result = input as PrivacyResult
  if (typeof result.redactedMarkdown !== "string" || !result.redactedMarkdown.trim()
    || !Array.isArray(result.findings) || !result.entityMap || typeof result.entityMap !== "object" || Array.isArray(result.entityMap)) return false
  const placeholders = new Set<string>()
  for (const finding of result.findings) {
    if (!finding || typeof finding.type !== "string" || typeof finding.displayName !== "string"
      || typeof finding.placeholder !== "string" || !PRIVACY_PLACEHOLDER.test(finding.placeholder)
      || !finding.placeholder.startsWith(`[${finding.type}_`) || placeholders.has(finding.placeholder)
      || !Object.hasOwn(result.entityMap, finding.placeholder)
      || typeof result.entityMap[finding.placeholder] !== "string" || !result.entityMap[finding.placeholder].trim()
      || !result.redactedMarkdown.includes(finding.placeholder)) return false
    placeholders.add(finding.placeholder)
  }
  return Object.keys(result.entityMap).every((key) => placeholders.has(key))
}
