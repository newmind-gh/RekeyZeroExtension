import type { Observation, ProfilePageTemplate, ProfileDriftReport, ProfileFieldTemplate } from "./types"

export function fieldTemplates(observation: Observation): ProfileFieldTemplate[] {
  return observation.fields.map(({ templateKey, identityKey, type, label }) => ({
    templateKey, ...(identityKey ? { identityKey } : {}), type, label,
  }))
}

export function driftReport(
  baseline: ProfilePageTemplate,
  observation: Observation,
  mappedKeys: string[],
  page: "source" | "target",
  targetId?: string,
): ProfileDriftReport {
  const oldFields = baseline.fields ?? []
  const report: ProfileDriftReport = {
    page, targetId, title: baseline.title, unchangedMappedFields: [], missingMappedFields: [],
    newFields: [], changedControlTypes: [], ambiguousFields: [], blockedKeys: [],
  }
  const mapped = new Set(mappedKeys.filter(Boolean))
  for (const key of mapped) {
    const previous = oldFields.filter((field) => field.templateKey === key)
    const current = observation.fields.filter((field) => field.templateKey === key)
    const name = previous[0]?.label || key
    const changedType = previous[0]?.identityKey && observation.fields.some((field) =>
      field.identityKey === previous[0].identityKey && field.type !== previous[0].type)
    if (changedType || (previous.length === 1 && current.length === 1 && current[0].type !== previous[0].type)) {
      report.changedControlTypes.push(name); report.blockedKeys.push(key)
    } else if (previous.length > 1 || current.length > 1 || current.some((field) =>
      !field.templateStable || !field.instanceStable || field.ambiguousInObservation)) {
      report.ambiguousFields.push(name); report.blockedKeys.push(key)
    } else if (!current.length) {
      report.missingMappedFields.push(name); report.blockedKeys.push(key)
    } else {
      report.unchangedMappedFields.push(name)
    }
  }
  report.newFields = observation.fields.filter((field) => !oldFields.some((old) =>
    old.templateKey === field.templateKey || (old.identityKey && old.identityKey === field.identityKey)))
    .map((field) => field.label)
  return report
}

export function hasBaselineOverlap(baseline: ProfilePageTemplate, observation: Observation): boolean {
  return Boolean(baseline.fields?.length && !observation.blockedReason && !observation.truncated
    && baseline.fields.some((old) => observation.fields.some((field) =>
      old.templateKey === field.templateKey || (old.identityKey && old.identityKey === field.identityKey))))
}
