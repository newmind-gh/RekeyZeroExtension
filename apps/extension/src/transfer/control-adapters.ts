import { equal } from "./planner"
import { scopeVisible } from "./dom-traversal"
import type { Field, Value } from "./types"

export type SemanticControlType = "text" | "number" | "date" | "boolean" | "single_select" | "single_choice" | "unsupported"
export type Control = { elements: Element[] }
export type ControlDescription = { type: string; semanticType: SemanticControlType; options: Field["options"]; writable: boolean }
export interface ControlAdapter {
  readonly id: string
  canHandle(element: Element): boolean
  observe(control: Control): ControlDescription
  read(control: Control): Value
  listAcceptedValues(control: Control): Field["options"]
  writeValue(control: Control, expected: Value, reviewedOptions: Field["options"], assertCurrent: () => Promise<void>): Promise<void>
  verifyValue(control: Control, expected: Value): boolean
}

const enabled = (element: Element) => !(element as HTMLInputElement).disabled && !(element as HTMLInputElement).readOnly &&
  !element.matches(":disabled") && !element.closest('[aria-disabled="true"], [inert]')
const valid = (control: Control) => control.elements.every((element) => element.isConnected &&
  !((element as HTMLInputElement).validity?.valid === false) && element.getAttribute("aria-invalid") !== "true")
export function rootElementById(element: Element, id: string): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot
  return root.getElementById?.(id) ?? null
}
const text = (element: Element) => element.getAttribute("aria-label") || element.textContent?.trim() || ""
function linkedListbox(element: Element): Element | null {
  const ids = element.getAttribute("aria-controls")?.trim().split(/\s+/) ?? []
  if (ids.length !== 1 || !ids[0]) return null
  const listbox = rootElementById(element, ids[0])
  if (!listbox?.matches('[role="listbox"]') || listbox.getAttribute("aria-multiselectable") === "true") return null
  // Shared or ambiguous popup ownership is never an editable control.
  const root = element.getRootNode() as Document | ShadowRoot
  const owners = Array.from(root.querySelectorAll('[role="combobox"][aria-controls]'))
    .filter((candidate) => candidate.getAttribute("aria-controls")?.trim().split(/\s+/).includes(ids[0]))
  return owners.length === 1 && owners[0] === element ? listbox : null
}
function optionElements(element: Element): Element[] {
  const listbox = linkedListbox(element)
  return Array.from(listbox?.querySelectorAll('[role="option"]') ?? []).filter((option) =>
    option.closest('[role="listbox"]') === listbox && enabled(option))
}
const optionValue = (option: Element) => option.getAttribute("data-rekeyzero-value") ?? option.getAttribute("data-value") ?? text(option)
function ariaOptions(element: Element): Field["options"] {
  const options = optionElements(element).map((option) => ({ value: optionValue(option), label: text(option) }))
  return options.length <= 200 && options.every((option) => option.value && option.label) &&
    new Set(options.map((option) => option.value)).size === options.length ? options : []
}
function declaredOptions(element: Element): Field["options"] {
  const raw = element.getAttribute("data-rekeyzero-options")
  if (!raw || raw.length > 20_000) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > 200) return []
    const options = parsed.flatMap((item) => item && typeof item === "object" && typeof item.value === "string" && typeof item.label === "string"
      ? [{ value: item.value, label: item.label }] : [])
    return options.length === parsed.length && new Set(options.map((option) => option.value)).size === options.length ? options : []
  } catch { return [] }
}
function safeCombobox(element: Element): boolean {
  return element.matches('[role="combobox"]') && !element.closest('a[href]') &&
    (!element.matches("button") || (element as HTMLButtonElement).type === "button") &&
    (!element.matches("input") || ["text", ""].includes((element as HTMLInputElement).type))
}
class ListboxAdapter implements ControlAdapter {
  constructor(readonly id: string, private readonly declared: boolean) {}
  canHandle(element: Element) {
    return safeCombobox(element) && (this.declared ? element.getAttribute("data-rekeyzero-control") === "listbox" : Boolean(linkedListbox(element)))
  }
  listAcceptedValues({ elements: [element] }: Control) { return this.declared ? declaredOptions(element) : ariaOptions(element) }
  observe(control: Control): ControlDescription {
    const options = this.listAcceptedValues(control)
    return { type: "combobox", semanticType: "single_select", options,
      writable: options.length > 0 && control.elements.every(enabled) && (this.declared || linkedListbox(control.elements[0]) !== null) }
  }
  read(control: Control): Value {
    const element = control.elements[0]
    if (this.declared) return element.getAttribute("data-rekeyzero-value") ?? null
    const options = this.listAcceptedValues(control)
    const selected = optionElements(element).filter((option) => option.getAttribute("aria-selected") === "true")
    const display = (element as HTMLInputElement).value ?? element.getAttribute("aria-valuetext") ?? text(element)
    if (selected.length === 1) {
      const option = selected[0]
      // Editable text must agree with the selected option; free-form typing is not selection.
      if (element.matches("input") && display !== text(option) && display !== optionValue(option)) return display || null
      return optionValue(option)
    }
    if (selected.length > 1) return "[ambiguous selection]"
    if (!display) return null
    const matches = options.filter((option) => option.label === display || option.value === display)
    return matches.length === 1 ? matches[0].value : display
  }
  async writeValue(control: Control, expected: Value, reviewedOptions: Field["options"], assertCurrent: () => Promise<void>) {
    const element = control.elements[0]
    if (typeof expected !== "string" || !reviewedOptions.some((option) => option.value === expected)) throw new Error("Selection is outside reviewed options")
    if (JSON.stringify(this.listAcceptedValues(control)) !== JSON.stringify(reviewedOptions)) throw new Error("Accepted options changed")
    const before = this.read(control)
    const listboxId = element.getAttribute("aria-controls")
    if (!listboxId || !safeCombobox(element)) throw new Error("Combobox has no bounded listbox identity")
    ;(element as HTMLElement).click()
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (!element.isConnected || element.getAttribute("aria-controls") !== listboxId || !equal(this.read(control), before)) throw new Error("Control changed while opening its options")
      const actual = ariaOptions(element)
      if (!actual.length) continue
      // Explicit adapter metadata must also match the live popup before any selection.
      if (JSON.stringify(actual) !== JSON.stringify(reviewedOptions)) throw new Error("Live options differ from the reviewed options")
      const matches = optionElements(element).filter((option) => optionValue(option) === expected)
      if (matches.length !== 1) throw new Error("Reviewed option is missing or ambiguous")
      const option = matches[0]
      if (option.closest('a[href], button[type="submit"], button:not([type])')) throw new Error("Option may submit or navigate")
      await assertCurrent()
      if (!scopeVisible(option) || !option.isConnected || JSON.stringify(ariaOptions(element)) !== JSON.stringify(reviewedOptions)) throw new Error("Options changed before selection")
      ;(option as HTMLElement).click()
      return
    }
    throw new Error("Combobox did not expose its reviewed options; open the control and observe again")
  }
  verifyValue(control: Control, expected: Value) {
    if (!valid(control) || !equal(this.read(control), expected)) return false
    if (!this.declared && control.elements[0].matches("input")) {
      return optionElements(control.elements[0]).filter((option) => option.getAttribute("aria-selected") === "true").length === 1
    }
    return true
  }
}
class NativeAdapter implements ControlAdapter {
  constructor(readonly id: string, private readonly selector: string, private readonly semantic: SemanticControlType) {}
  canHandle(element: Element) { return element.matches(this.selector) && !element.hasAttribute("role") }
  listAcceptedValues({ elements: [element, ...rest] }: Control): Field["options"] {
    if (element.tagName === "SELECT") return Array.from((element as HTMLSelectElement).options)
      .filter((option) => !option.disabled && !(option.parentElement?.tagName === "OPTGROUP" && (option.parentElement as HTMLOptGroupElement).disabled))
      .map((option) => ({ value: option.value, label: option.label }))
    if ((element as HTMLInputElement).type === "radio") return [element, ...rest].filter(enabled).map((option) => ({
      value: (option as HTMLInputElement).value, label: Array.from((option as HTMLInputElement).labels ?? []).map((label) => label.textContent).join(" ").trim() || option.getAttribute("aria-label") || "" }))
    return []
  }
  observe(control: Control): ControlDescription {
    const element = control.elements[0]
    const type = element.tagName === "INPUT" ? (element as HTMLInputElement).type : element.tagName.toLowerCase()
    return { type, semanticType: type === "number" ? "number" : type === "date" ? "date" : this.semantic,
      options: this.listAcceptedValues(control), writable: control.elements.every(enabled) && !(element.tagName === "SELECT" && (element as HTMLSelectElement).multiple) }
  }
  read({ elements }: Control): Value {
    const first = elements[0] as HTMLInputElement
    if (first.type === "radio") return (elements as HTMLInputElement[]).find((element) => element.checked)?.value ?? null
    if (first.type === "checkbox") return first.checked
    return first.value
  }
  async writeValue({ elements }: Control, expected: Value, _reviewedOptions: Field["options"], assertCurrent: () => Promise<void>) {
    await assertCurrent()
    const first = elements[0] as HTMLInputElement
    // Use the control's own realm, including same-origin child documents.
    const realm = first.ownerDocument.defaultView!
    const set = (element: Element, property: string, value: unknown) => {
      const prototype = element.tagName === "SELECT" ? realm.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? realm.HTMLTextAreaElement.prototype : realm.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, property)!.set!.call(element, value)
    }
    if (first.type === "radio") for (const element of elements as HTMLInputElement[]) set(element, "checked", element.value === expected)
    else if (first.type === "checkbox") set(first, "checked", expected)
    else set(first, "value", expected ?? "")
    const changed = first.type === "radio" ? elements.find((element) => (element as HTMLInputElement).value === expected) ?? first : first
    changed.dispatchEvent(new realm.Event("input", { bubbles: true, composed: true }))
    changed.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }))
  }
  verifyValue(control: Control, expected: Value) { return valid(control) && equal(this.read(control), expected) }
}
class ReadOnlyAdapter implements ControlAdapter {
  readonly id = "read-only"
  canHandle() { return true }
  listAcceptedValues(): Field["options"] { return [] }
  observe({ elements: [element] }: Control): ControlDescription {
    return { type: element.matches('[role="combobox"]') ? "custom_combobox" : element.tagName === "INPUT" ? (element as HTMLInputElement).type : element.tagName.toLowerCase(), semanticType: "unsupported", options: [], writable: false }
  }
  read({ elements: [element] }: Control): Value { return element.matches('[role="combobox"]') ? element.getAttribute("data-rekeyzero-value") ?? null : (element as HTMLInputElement).value ?? element.textContent?.trim() ?? "" }
  async writeValue(): Promise<void> { throw new Error("Control has no writable adapter") }
  verifyValue() { return false }
}
// Specific adapters precede native adapters. No navigation, submission, or model-generated actions.
export const controlAdapters: readonly ControlAdapter[] = [
  new ListboxAdapter("rekeyzero-listbox", true), new ListboxAdapter("aria-listbox", false),
  new NativeAdapter("native-select", "select", "single_select"),
  new NativeAdapter("native-radio", 'input[type="radio"]', "single_choice"),
  new NativeAdapter("native-checkbox", 'input[type="checkbox"]', "boolean"),
  new NativeAdapter("native-input", 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], textarea', "text"),
  new ReadOnlyAdapter(),
]
export const adapterFor = (element: Element): ControlAdapter => controlAdapters.find((adapter) => adapter.canHandle(element))!
