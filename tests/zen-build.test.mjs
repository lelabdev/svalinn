import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  buildInjectionScript,
  loadInjectionScript,
  stripModuleSyntax,
} from "../src/zen/build.mjs";

test("strips imports and exports from ES modules", () => {
  const source = `import { a } from "./a.mjs";
export const b = a + 1;
export function c() {
  return b;
}
export { c };
`;
  const output = stripModuleSyntax(source);
  assert.doesNotMatch(output, /^\s*import\s/m);
  assert.doesNotMatch(output, /^\s*export\s/m);
  assert.match(output, /const b = a \+ 1;/);
  assert.match(output, /function c\(\)/);
});

test("bundles modules in dependency order with the adapter last", () => {
  const script = buildInjectionScript({
    modules: [
      { name: "first.mjs", source: "export function first() { return 1; }" },
      { name: "second.mjs", source: "export function second() { return first() + 1; }" },
    ],
    adapter: "globalThis.result = second();",
  });
  const context = vm.createContext({});
  vm.runInContext(script, context);
  assert.equal(context.result, 2);
});

test("real injection script parses and exposes the adapter", async () => {
  const script = await loadInjectionScript();
  assert.match(script, /function zoneOf\(/);
  assert.match(script, /function probeCapabilities\(/);
  assert.match(script, /globalThis\.Svalinn = api;/);
  assert.doesNotMatch(script, /^\s*import\s/m);
  assert.doesNotMatch(script, /^\s*export\s/m);
  assert.doesNotThrow(() => new vm.Script(script, { filename: "svalinn-inject.js" }));
});
