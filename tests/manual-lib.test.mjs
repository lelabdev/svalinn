import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  profileMatchesSession,
  validateManualSession,
} from "../src/zen/manual-lib.mjs";

const valid = {
  ready: { ready: true, version: "1.23.4b" },
  installed: { status: "installed", windows: 1 },
  guards: {
    drop: 1,
    close: 1,
    windows: [{ hooked: true, closeHooked: true }],
  },
};

test("accepts a fully initialized and guarded manual session", () => {
  assert.deepEqual(validateManualSession(valid), {
    ok: true,
    version: "1.23.4b",
  });
});

test("rejects failed, missing or not-ready startup responses", () => {
  for (const ready of [
    undefined,
    null,
    {},
    { ready: false },
    { ready: true, error: "boom" },
    { error: "startup failed" },
  ]) {
    const result = validateManualSession({ ...valid, ready });
    assert.equal(result.ok, false);
    assert.match(result.error, /startup/i);
  }
});

test("rejects unsupported, disabled, not-ready or failed installs", () => {
  for (const status of [
    "unsupported",
    "not-ready",
    "disabled",
    "already-installed",
    undefined,
  ]) {
    const result = validateManualSession({
      ...valid,
      installed: { status, windows: 1 },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /install failed/i);
  }

  const errorResult = validateManualSession({
    ...valid,
    installed: { error: "capability missing" },
  });
  assert.equal(errorResult.ok, false);
  assert.match(errorResult.error, /capability missing/);

  const noWindow = validateManualSession({
    ...valid,
    installed: { status: "installed", windows: 0 },
  });
  assert.equal(noWindow.ok, false);
  assert.match(noWindow.error, /no attached window/);
});

test("rejects missing or partial guard attachment", () => {
  for (const guards of [
    undefined,
    null,
    { drop: 0, close: 1, windows: [] },
    { drop: 1, close: 0, windows: [] },
    { drop: 1, close: 1, windows: [] },
    { drop: 1, close: 1, windows: [{ hooked: false, closeHooked: true }] },
    { drop: 1, close: 1, windows: [{ hooked: true, closeHooked: false }] },
  ]) {
    const result = validateManualSession({ ...valid, guards });
    assert.equal(result.ok, false);
    assert.match(result.error, /guard|hook|window/i);
  }
});

test("profile comparison resolves symlinked disposable aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "svalinn-manual-profile-"));
  try {
    const target = path.join(root, "target");
    await fs.mkdir(target);
    const alias = path.join(root, "alias");
    await fs.symlink(target, alias);

    assert.equal(await profileMatchesSession(alias, target), true);
    assert.equal(await profileMatchesSession(target, root), false);
    assert.equal(await profileMatchesSession(null, target), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
