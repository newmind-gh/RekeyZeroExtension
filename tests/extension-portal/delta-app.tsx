import React, { useRef, useState } from "react"
import { createRoot } from "react-dom/client"

type Option = { value: string; label: string }

function Combobox({ label, value, options, onChange }: {
  label: string
  value: string
  options: Option[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const instanceId = useRef(crypto.randomUUID()).current
  const listboxId = `delta-${label.toLowerCase().replace(/\s+/g, "-")}-${instanceId}`
  const selected = options.find((option) => option.value === value)
  return <div className="delta-control">
    <span>{label}</span>
    <button
      type="button"
      role="combobox"
      aria-label={label}
      aria-controls={listboxId}
      aria-expanded={open}
      data-rekeyzero-control="listbox"
      data-rekeyzero-value={value}
      data-rekeyzero-options={JSON.stringify(options)}
      data-react-instance={instanceId}
      onClick={() => setOpen((current) => !current)}
    >{selected?.label ?? `Choose ${label.toLowerCase().replace(/\s+/g, "-")}`}</button>
    {open && <div id={listboxId} role="listbox">
      {options.map((option) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        data-rekeyzero-value={option.value}
        key={option.value}
        onClick={() => { onChange(option.value); setOpen(false) }}
      >{option.label}</button>)}
    </div>}
  </div>
}

function DeltaApp() {
  const [company, setCompany] = useState("")
  const [email, setEmail] = useState("")
  const [turnover, setTurnover] = useState("")
  const [state, setState] = useState("")
  const [industry, setIndustry] = useState("")
  const [category, setCategory] = useState("")
  const submissionDialog = useRef<HTMLDialogElement>(null)
  const categoryOptions: Record<string, Option[]> = {
    retail: [{ value: "marketplace", label: "Marketplace seller" }, { value: "direct", label: "Direct retailer" }],
    services: [{ value: "digital", label: "Digital services" }],
  }
  const updateIndustry = (value: string) => {
    setIndustry(value)
    setCategory("")
  }
  return <main className="delta-app">
    <header><div><small>System Delta</small><h2>Modern Portal</h2></div><span>React controlled</span></header>
    <section className="delta-card">
      <label>Legal company name<input aria-label="Legal company name" name="deltaLegalEntity" value={company} onChange={(event) => setCompany(event.target.value)} /></label>
      <label>Contact email<input aria-label="Contact email" name="deltaContactEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Annual turnover<input aria-label="Annual turnover" name="deltaAnnualTurnover" type="number" value={turnover} onChange={(event) => setTurnover(event.target.value)} /></label>
      <Combobox label="State" value={state} options={[
        { value: "AU-NSW", label: "New South Wales" },
        { value: "AU-VIC", label: "Victoria" },
      ]} onChange={setState} />
      <Combobox key={industry || "unselected"} label="Business category" value={category} options={categoryOptions[industry] ?? []} onChange={setCategory} />
      <label>Industry<select aria-label="Industry" name="deltaIndustry" value={industry} onChange={(event) => updateIndustry(event.target.value)}>
        <option value="">Choose industry</option><option value="retail">Online retail</option><option value="services">Business services</option>
      </select></label>
    </section>
    <section className="delta-state" aria-label="React state read-back">
      <h3>React state</h3>
      <output role="status">{JSON.stringify({ company, email, turnover, state, industry, category })}</output>
    </section>
    <button type="button" onClick={() => submissionDialog.current?.showModal()}>Submit</button>
    <dialog ref={submissionDialog} aria-label="Transferred values">
      <h2>Transferred values</h2>
      <pre>{JSON.stringify({
        "Legal company name": company,
        "Contact email": email,
        "Annual turnover": turnover,
        State: state,
        Industry: industry,
        "Business category": category,
      }, null, 2)}</pre>
      <button type="button" onClick={() => submissionDialog.current?.close()}>Close</button>
    </dialog>
  </main>
}

createRoot(document.getElementById("delta-root")!).render(<DeltaApp />)
