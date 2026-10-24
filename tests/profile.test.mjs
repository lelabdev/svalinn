import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDisposableProfile,
  isPathInside,
  realpathAllowMissing,
  sameRealPath,
} from "../src/zen/profile.mjs";

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "svalinn-profile-test-"));
  const home = path.join(root, "home");
  const homeZen = path.join(home, ".zen");
  await fs.mkdir(homeZen, { recursive: true });
  return { root, home, homeZen };
}

test("path containment is boundary-safe", () => {
  assert.equal(isPathInside("/home/user/.zen", "/home/user/.zen"), true);
  assert.equal(isPathInside("/home/user/.zen/session", "/home/user/.zen"), true);
  assert.equal(isPathInside("/home/user/.zen2", "/home/user/.zen"), false);
  assert.equal(isPathInside("/home/user/.zen/../x", "/home/user/.zen"), false);
});

test("realpathAllowMissing resolves symlinked ancestors and missing children", async () => {
  const { root, homeZen } = await makeFixture();
  try {
    const alias = path.join(root, "alias");
    await fs.symlink(homeZen, alias);
    const target = path.join(alias, "does-not-exist");
    assert.equal(
      await realpathAllowMissing(target),
      path.join(await fs.realpath(homeZen), "does-not-exist")
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses the real daily profile directly and through traversal", async () => {
  const { root, home, homeZen } = await makeFixture();
  try {
    await assert.rejects(
      assertDisposableProfile(homeZen, { homeDir: home }),
      /daily Zen profile/
    );
    await assert.rejects(
      assertDisposableProfile(path.join(homeZen, "child"), { homeDir: home }),
      /daily Zen profile/
    );
    assert.equal(await fs.stat(homeZen).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses a symlinked alias into the fake daily profile before writing", async () => {
  const { root, home, homeZen } = await makeFixture();
  try {
    const alias = path.join(root, "disposable-looking-alias");
    await fs.symlink(homeZen, alias);
    const intended = path.join(alias, "session");

    await assert.rejects(
      assertDisposableProfile(intended, { homeDir: home }),
      /daily Zen profile/
    );
    await assert.rejects(fs.stat(intended));
    assert.deepEqual(await fs.readdir(homeZen), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses a symlinked alias whose missing target is inside .zen", async () => {
  const { root, home, homeZen } = await makeFixture();
  try {
    const alias = path.join(root, "missing-target-alias");
    const forbidden = path.join(homeZen, "not-yet-created");
    await fs.symlink(forbidden, alias);

    await assert.rejects(
      assertDisposableProfile(alias, { homeDir: home }),
      /daily Zen profile/
    );
    await assert.rejects(fs.stat(forbidden));
    assert.deepEqual(await fs.readdir(homeZen), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("allows direct and symlinked temporary destinations outside .zen", async () => {
  const { root, home } = await makeFixture();
  try {
    const direct = path.join(root, "custom-session");
    assert.equal(
      await assertDisposableProfile(direct, { homeDir: home }),
      direct
    );

    const allowedTarget = path.join(root, "allowed");
    await fs.mkdir(allowedTarget);
    const allowedAlias = path.join(root, "allowed-alias");
    await fs.symlink(allowedTarget, allowedAlias);
    const viaAlias = path.join(allowedAlias, "session");
    await fs.mkdir(viaAlias);

    assert.equal(
      await assertDisposableProfile(viaAlias, { homeDir: home }),
      path.join(await fs.realpath(allowedTarget), "session")
    );
    assert.equal(await sameRealPath(viaAlias, viaAlias), true);
    assert.equal(
      await sameRealPath(viaAlias, path.join(allowedTarget, "session")),
      true
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
