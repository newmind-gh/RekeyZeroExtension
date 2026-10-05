import type { Field, Value } from "../../transfer/types"

export function isBlankSourceValue(value: Value): boolean {
  return value === null || (typeof value === "string" && !value.trim())
}
const aliases: Record<string, string> = {
  "new south wales": "nsw", victoria: "vic", queensland: "qld", "south australia": "sa",
  "western australia": "wa", tasmania: "tas", "northern territory": "nt", "australian capital territory": "act",
}
const canonical = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ")

function numeric(value: string | number): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? String(value) : undefined
  const match = value.trim().match(/^(?:[$£€]\s*)?(-?)(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*([km])?$/i)
  if (!match) return undefined
  const [whole, fraction = ""] = match[2].replaceAll(",", "").split(".")
  const shift = match[3]?.toLowerCase() === "m" ? 6 : match[3]?.toLowerCase() === "k" ? 3 : 0
  const digits = whole + fraction.padEnd(shift, "0")
  const position = whole.length + shift
  const integer = digits.slice(0, position).replace(/^0+(?=\d)/, "")
  const decimal = digits.slice(position).replace(/0+$/, "")
  const normalized = `${match[1]}${integer}${decimal ? `.${decimal}` : ""}`
  const amount = Number(normalized)
  return Number.isFinite(amount) && Math.abs(amount) <= Number.MAX_SAFE_INTEGER ? normalized : undefined
}
function date(value: string): string | undefined {
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const named = value.trim().match(/^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i)
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
  if (!iso && !named) return undefined
  const year = Number(iso?.[1] ?? named![3]), month = iso ? Number(iso[2]) : months.indexOf(named![2].toLowerCase()) + 1
  const day = Number(iso?.[3] ?? named![1])
  if (year < 1000 || year > 9999) return undefined
  const checked = new Date(Date.UTC(year, month - 1, day))
  return checked.getUTCFullYear() === year && checked.getUTCMonth() === month - 1 && checked.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : undefined
}
export function normalizeSourceValue(value: unknown, field: Field): Value | undefined {
  if (!field.writable || value === null || value === undefined || !["string", "number", "boolean"].includes(typeof value)) return undefined
  if (field.type === "checkbox") {
    if (typeof value === "boolean") return value
    const text = canonical(String(value))
    return ["yes", "true"].includes(text) ? true : ["no", "false"].includes(text) ? false : undefined
  }
  if (field.options.length) {
    const text = canonical(String(value)), alias = aliases[text] ?? text
    const matches = field.options.filter((option) => option.value !== "" && [canonical(option.value), canonical(option.label)].some((candidate) => candidate === text || candidate === alias))
    return matches.length === 1 ? matches[0].value : undefined
  }
  if (field.type === "number") return typeof value === "string" || typeof value === "number" ? numeric(value) : undefined
  if (field.type === "date") return typeof value === "string" ? date(value) : undefined
  if (!["text", "textarea", "email", "tel", "url"].includes(field.type) || typeof value === "boolean") return undefined
  const text = String(value).trim().replace(/\s+/g, " ")
  return text && text.length <= 10_000 ? text : undefined
}
