import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../userChrome.css", import.meta.url), "utf8");

test("close-hiding rules are scoped to the active Svalinn window marker", () => {
  const closeRules = css
    .split("}")
    .map(block => block.trim())
    .filter(block => block.includes("tab-close-button") || block.includes("close-icon"));

  assert.ok(closeRules.length > 0);
  for (const rule of closeRules) {
    assert.match(rule, /:root\[svalinn-active\]/);
  }
});

test("close-hiding rules cover Pinned, Essential and overlay controls", () => {
  assert.match(css, /\.tabbrowser-tab\[pinned\][^,{]*\.tab-close-button/);
  assert.match(css, /\.tabbrowser-tab\[zen-essential\][^,{]*\.tab-close-button/);
  assert.match(css, /\.tab-icon-overlay\[closebutton\]/);
});

test("CSS has no persistent unlocked bypass", () => {
  assert.doesNotMatch(css, /svalinn-unlocked/);
  assert.doesNotMatch(css, /display:\s*flex\s*!important/);
});

test("normal tabs are not matched by a bare close-button rule", () => {
  assert.doesNotMatch(
    css,
    /(^|\n)\s*\.tabbrowser-tab\s+\.tab-close-button/
  );
});
