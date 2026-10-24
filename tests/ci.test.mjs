import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);

test("CI runs for pull requests and main pushes", () => {
  assert.match(workflow, /^on:/m);
  assert.match(workflow, /^  push:/m);
  assert.match(workflow, /^    branches:/m);
  assert.match(workflow, /^\s+- main$/m);
  assert.match(workflow, /^  pull_request:/m);
});

test("CI runs the repository test and check scripts on supported Node versions", () => {
  assert.match(workflow, /^\s+- 22$/m);
  assert.match(workflow, /^\s+- 24$/m);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run check/);
});

test("CI has read-only repository permissions", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
});

test("manual checklist exists and names the required browser prerequisites", async () => {
  const checklist = await readFile(
    new URL("../docs/manual-zen-checklist.md", import.meta.url),
    "utf8"
  );
  assert.match(checklist, /1\.23\.4b/);
  assert.match(checklist, /Node/);
  assert.match(checklist, /disposable/i);
  assert.match(checklist, /npm run zen:manual/);
  assert.match(checklist, /Ctrl\+W/);
  assert.match(checklist, /workspace/i);
  assert.match(checklist, /container/i);
  assert.match(checklist, /Remaining cases/);
});
