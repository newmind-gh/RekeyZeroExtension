import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { Plugin } from "vite"

type PackageMetadata = {
  package_name: string
  version: string
  license: string
  module_count: number
  bundled_files: string[]
}

function packageRoot(moduleId: string): string | null {
  const normalized = moduleId.replace(/^\0+/, "").replaceAll("\\", "/").split("?", 1)[0]
  const marker = "/node_modules/"
  const markerAt = normalized.lastIndexOf(marker)
  if (markerAt < 0) return null
  const remainder = normalized.slice(markerAt + marker.length)
  const segments = remainder.split("/")
  const packageSegments = segments[0]?.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1)
  if (!packageSegments.length || packageSegments.some((segment) => !segment)) return null
  return `${normalized.slice(0, markerAt + marker.length)}${packageSegments.join("/")}`
}

export function distributedDependencyMetadata(buildPart: "application" | "content-script"): Plugin {
  return {
    name: `rekeyzero-distributed-dependencies-${buildPart}`,
    generateBundle(_options, bundle) {
      const packages = new Map<string, PackageMetadata & { bundled_files_set: Set<string> }>()
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        for (const moduleId of Object.keys(output.modules)) {
          const root = packageRoot(moduleId)
          if (!root) continue
          const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            name?: string
            version?: string
            license?: string | { type?: string }
          }
          const packageName = packageJson.name ?? root.replaceAll("\\", "/").split("/node_modules/").at(-1)!
          const version = packageJson.version ?? "unknown"
          const key = `${packageName}@${version}`
          const existing = packages.get(key) ?? {
            package_name: packageName,
            version,
            license: typeof packageJson.license === "string"
              ? packageJson.license
              : packageJson.license?.type ?? "unknown",
            module_count: 0,
            bundled_files: [],
            bundled_files_set: new Set<string>(),
          }
          existing.module_count += 1
          existing.bundled_files_set.add(output.fileName)
          packages.set(key, existing)
        }
      }
      const inventory = [...packages.values()]
        .map(({ bundled_files_set, ...entry }) => ({
          ...entry,
          bundled_files: [...bundled_files_set].sort(),
        }))
        .sort((left, right) => left.package_name.localeCompare(right.package_name))
      const target = resolve(
        import.meta.dirname,
        "../..",
        "artifacts/extension-build-metadata",
        `personal-${buildPart}.json`,
      )
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `${JSON.stringify(inventory, null, 2)}\n`)
    },
  }
}
