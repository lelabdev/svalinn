import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const persistent = path.join(root, "src", "zen", "persistent");

async function read(name) {
  return fs.readFile(path.join(persistent, name), "utf8");
}

test("persistent loader never references a debugging port", async () => {
  const loader = await read("loader.sys.mjs");
  assert.doesNotMatch(loader, /--marionette/);
  assert.doesNotMatch(loader, /remote-allow-system-access/i);
  assert.doesNotMatch(loader, /debugger/i);
  assert.match(loader, /chrome:\/\/svalinn\/content\/adapter\.js/);
  assert.match(loader, /waitForStartup:\s*true/);
});

test("autoconfig bootloader registers the profile loader", async () => {
  const config = await read("svalinn.cfg");
  assert.match(config, /UChrm/);
  assert.match(config, /autoRegister/);
  assert.match(config, /chrome:\/\/svalinn\/content\/loader\.sys\.mjs/);
  assert.doesNotMatch(config, /marionette/i);

  const pref = await read("svalinn-autoconfig.js");
  assert.match(pref, /general\.config\.filename/);
  assert.match(pref, /"svalinn\.cfg"/);
  assert.match(pref, /general\.config\.obscure_value/);
});

test("profile chrome manifest maps the loader content package", async () => {
  assert.match(await read("chrome.manifest"), /content\s+svalinn\s+content\//);
});

test("package exposes installer and installed-smoke commands", async () => {
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8")
  );
  assert.equal(typeof pkg.scripts["zen:install"], "string");
  assert.equal(typeof pkg.scripts["zen:installed-smoke"], "string");
  assert.match(pkg.scripts.check, /install-lib\.mjs/);
  assert.match(pkg.scripts.check, /installed-smoke\.mjs/);
});
