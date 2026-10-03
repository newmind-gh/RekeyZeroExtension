import { copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { extensionOutputDirectory } from "./build-output"
import { distributedDependencyMetadata } from "./vite.distributed-metadata"

export default defineConfig(() => {
  const outputDirectory = extensionOutputDirectory()
  const localAiFamily = process.env.REKEYZERO_LOCAL_AI_FAMILY || "local"
  const webLlmRuntimeEntry = process.env.REKEYZERO_WEBLLM_RUNTIME_ENTRY
  return {
    define: {
      __REKEYZERO_LOCAL_AI_FAMILY__: JSON.stringify(localAiFamily),
    },
    resolve: {
      alias: {
        ...(webLlmRuntimeEntry ? { "@mlc-ai/web-llm": webLlmRuntimeEntry } : {}),
      },
    },
    ssr: {
      noExternal: ["@mlc-ai/web-llm"],
    },
    plugins: [
      react(),
      distributedDependencyMetadata("application"),
      {
        name: "copy-extension-manifest",
        closeBundle() {
          mkdirSync(outputDirectory, { recursive: true })
          copyFileSync(
            resolve(import.meta.dirname, "manifest.personal.json"),
            resolve(outputDirectory, "manifest.json"),
          )
        },
      },
    ],
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          sidepanel: resolve(import.meta.dirname, "sidepanel.html"),
          "service-worker": resolve(import.meta.dirname, "src/background/service-worker.ts"),
          rekeyzero: resolve(import.meta.dirname, "rekeyzero.html"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  }
})
