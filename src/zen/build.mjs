/**
 * Tiny dependency-free bundler for the browser adapter.
 *
 * `policy.mjs` and the `src/zen/*.mjs` helpers are normal ES modules for Node
 * tests. The browser adapter is injected as one classic script, so this module
 * strips imports/exports and concatenates the files in dependency order. That
 * keeps a single source of truth for the policy and capability checks.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const MODULE_FILES = Object.freeze([
  { name: "src/policy.mjs", relative: "../policy.mjs" },
  { name: "src/zen/version.mjs", relative: "version.mjs" },
  { name: "src/zen/capabilities.mjs", relative: "capabilities.mjs" },
  { name: "src/zen/tabs.mjs", relative: "tabs.mjs" },
]);

export const ADAPTER_FILE = Object.freeze({
  name: "src/zen/adapter.body.js",
  relative: "adapter.body.js",
});

/**
 * Remove module-only syntax from a source file.
 *
 * All project modules use single-line imports and either `export const`,
 * `export function`, or a single `export { ... };` list, which keeps this
 * transform intentionally small and auditable.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripModuleSyntax(source) {
  return source
    .replace(/^\s*import\s+[^;]*;\s*$/gm, "")
    .replace(/^\s*export\s*\{[^}]*\};\s*$/gm, "")
    .replace(/^\s*export\s+/gm, "");
}

/**
 * Build the script evaluated in Zen's chrome context.
 *
 * @param {{ modules: Array<{ name: string, source: string }>, adapter: string }} input
 * @returns {string}
 */
export function buildInjectionScript({ modules, adapter }) {
  const parts = modules.map(
    module => `// --- ${module.name} ---\n${stripModuleSyntax(module.source)}`
  );
  parts.push(`// --- ${ADAPTER_FILE.name} ---\n${adapter}`);
  return `(function () {\n"use strict";\n${parts.join("\n")}\n})();\n`;
}

/**
 * Read and bundle the repository's real sources.
 *
 * @returns {Promise<string>}
 */
export async function loadInjectionScript() {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const modules = [];
  for (const file of MODULE_FILES) {
    modules.push({
      name: file.name,
      source: await readFile(path.resolve(base, file.relative), "utf8"),
    });
  }
  const adapter = await readFile(
    path.resolve(base, ADAPTER_FILE.relative),
    "utf8"
  );
  return buildInjectionScript({ modules, adapter });
}
