// Checksum behaviour follows Microsoft Presidio's Australian recognizers
// (MIT). ACN's zero-complement case follows ASIC's modulus-10 specification.
// https://github.com/microsoft/presidio/tree/main/presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/australia
export type AustralianIdentifierType = "AU_TFN" | "AU_MEDICARE" | "AU_ABN" | "AU_ACN"
export type AustralianIdentifierSpan = { start: number; end: number; type: AustralianIdentifierType }

function weighted(digits: number[], weights: number[]): number {
  return weights.reduce((sum, weight, index) => sum + digits[index] * weight, 0)
}

// Compact numbers need an explicit label to avoid treating commercial amounts
// and unrelated references as identifiers. Standard grouped formats can be
// detected without a label, but still require a checksum and numeric boundaries.
export function detectAustralianIdentifiers(markdown: string): AustralianIdentifierSpan[] {
  const recognizers: Array<{ type: AustralianIdentifierType; pattern: RegExp; valid: (digits: number[]) => boolean }> = [
    { type: "AU_TFN", pattern: /(?<![\p{L}\p{N}_])(?:TFN|tax[ \t]+file[ \t]+number)[ \t]*[:#=-]?[ \t]*(?<value>[0-9]{3}[ \t]?[0-9]{3}[ \t]?[0-9]{3})(?![\p{L}\p{N}_])/giu,
      valid: (digits) => weighted(digits, [1, 4, 3, 7, 5, 8, 6, 9, 10]) % 11 === 0 },
    { type: "AU_MEDICARE", pattern: /(?<![\p{L}\p{N}_])Medicare(?:[ \t]+(?:card|number))?[ \t]*[:#=-]?[ \t]*(?<value>[2-6][0-9]{3}[ \t]?[0-9]{5}[ \t]?[0-9])(?![\p{L}\p{N}_])/giu,
      valid: (digits) => weighted(digits, [1, 3, 7, 9, 1, 3, 7, 9]) % 10 === digits[8] },
    { type: "AU_ABN", pattern: /(?<![\p{L}\p{N}_])(?:ABN|Australian[ \t]+business[ \t]+number)[ \t]*[:#=-]?[ \t]*(?<value>[0-9]{2}[ \t]?[0-9]{3}[ \t]?[0-9]{3}[ \t]?[0-9]{3})(?![\p{L}\p{N}_])/giu,
      valid: (digits) => weighted([digits[0] - 1, ...digits.slice(1)], [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]) % 89 === 0 },
    { type: "AU_ACN", pattern: /(?<![\p{L}\p{N}_])(?:ACN|Australian[ \t]+company[ \t]+number)[ \t]*[:#=-]?[ \t]*(?<value>[0-9]{3}[ \t]?[0-9]{3}[ \t]?[0-9]{3})(?![\p{L}\p{N}_])/giu,
      valid: (digits) => (10 - weighted(digits, [8, 7, 6, 5, 4, 3, 2, 1]) % 10) % 10 === digits[8] },
  ]
  const spans: AustralianIdentifierSpan[] = []
  for (const recognizer of recognizers) {
    for (const match of markdown.matchAll(recognizer.pattern)) {
      const value = match.groups!.value
      const digits = [...value.replace(/[ \t]/g, "")].map(Number)
      if (!digits.some(Boolean) || !recognizer.valid(digits)) continue
      const start = match.index! + match[0].length - value.length
      spans.push({ start, end: start + value.length, type: recognizer.type })
    }
  }
  const grouped: Record<AustralianIdentifierType, RegExp> = {
    AU_TFN: /(?<![\p{L}\p{N}_])(?<value>[0-9]{3}[ \t][0-9]{3}[ \t][0-9]{3})(?![\p{L}\p{N}_])/gu,
    AU_ACN: /(?<![\p{L}\p{N}_])(?<value>[0-9]{3}[ \t][0-9]{3}[ \t][0-9]{3})(?![\p{L}\p{N}_])/gu,
    AU_ABN: /(?<![\p{L}\p{N}_])(?<value>[0-9]{2}[ \t][0-9]{3}[ \t][0-9]{3}[ \t][0-9]{3})(?![\p{L}\p{N}_])/gu,
    AU_MEDICARE: /(?<![\p{L}\p{N}_])(?<value>[2-6][0-9]{3}[ \t][0-9]{5}[ \t][0-9])(?![\p{L}\p{N}_])/gu,
  }
  for (const recognizer of recognizers) {
    for (const match of markdown.matchAll(grouped[recognizer.type])) {
      const start = match.index!, end = start + match[0].length
      if (/[0-9][ \t]+$/.test(markdown.slice(Math.max(0, start - 16), start))
        || /^[ \t]+[0-9]/.test(markdown.slice(end, end + 16))) continue
      const digits = [...match[0].replace(/[ \t]/g, "")].map(Number)
      if (!digits.some(Boolean) || !recognizer.valid(digits)) continue
      // A context-qualified result wins over an unlabeled overlapping candidate.
      if (spans.some((span) => start < span.end && end > span.start)) continue
      spans.push({ start, end, type: recognizer.type })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}
