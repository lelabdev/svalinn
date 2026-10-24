import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InstallError,
  USERJS_END,
  USERJS_START,
  findAutoconfigConflict,
  inspectInstallRoot,
  install,
  mergeManagedUserJs,
  readManagedState,
  removeManagedUserJs,
  rollback,
  status,
  uninstall,
} from "../src/zen/install-lib.mjs";

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "svalinn-install-test-"));
}

async function makeFakeZen(root, { version = "1.23.4b", name = "Zen" } = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "application.ini"),
    `[App]\nName=${name}\nVersion=${version}\n`
  );
  const binary = path.join(root, "zen-bin");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n");
  await fs.chmod(binary, 0o755);
  return root;
}

async function makeProfile(root) {
  const profile = path.join(root, "profile");
  await fs.mkdir(profile, { recursive: true });
  return profile;
}

test("managed user.js block is idempotent, updateable and removable", () => {
  const original =
    '// user comment\nuser_pref("browser.startup.page", 3);\n' +
    'user_pref("svalinn.enabled", false);\n';
  const merged = mergeManagedUserJs(original, {
    enabled: true,
    dragBehavior: "block",
  });

  assert.match(merged, /user_pref\("browser\.startup\.page", 3\);/);
  assert.match(merged, /user_pref\("svalinn\.enabled", true\);/);
  assert.equal(merged.split(USERJS_START).length - 1, 1);
  assert.equal(merged.split(USERJS_END).length - 1, 1);

  const updated = mergeManagedUserJs(merged, {
    enabled: false,
    dragBehavior: "duplicate",
  });
  assert.equal(updated.split(USERJS_START).length - 1, 1);
  assert.match(updated, /user_pref\("svalinn\.enabled", false\);/);
  assert.match(
    updated,
    /user_pref\("svalinn\.protectedDragBehavior", "duplicate"\);/
  );
  assert.match(
    updated,
    /user_pref\("toolkit\.legacyUserProfileCustomizations\.stylesheets", true\);/
  );
  assert.match(updated, /browser\.startup\.page/);

  const removed = removeManagedUserJs(updated);
  assert.doesNotMatch(removed, /Svalinn managed preferences/);
  assert.match(removed, /browser\.startup\.page/);
});

test("inspectInstallRoot accepts Zen and rejects other applications", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const inspected = await inspectInstallRoot(zen);
    assert.equal(inspected.name, "Zen");
    assert.equal(inspected.version, "1.23.4b");
    assert.equal(inspected.binary, path.join(zen, "zen-bin"));

    const other = await makeFakeZen(path.join(root, "other"), {
      name: "Firefox",
    });
    await assert.rejects(inspectInstallRoot(other), /not Zen/);
    await assert.rejects(inspectInstallRoot(path.join(root, "missing")), /application.ini/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("autoconfig conflict detection ignores only Svalinn's own pref file", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const prefDir = path.join(zen, "defaults", "pref");
    await fs.mkdir(prefDir, { recursive: true });
    await fs.writeFile(
      path.join(prefDir, "svalinn-autoconfig.js"),
      'pref("general.config.filename", "svalinn.cfg");\n'
    );
    assert.deepEqual(await findAutoconfigConflict(zen), []);

    const other = path.join(prefDir, "config-prefs.js");
    await fs.writeFile(other, 'pref("general.config.filename", "config.js");\n');
    assert.deepEqual(await findAutoconfigConflict(zen), [other]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install/status/uninstall work on a disposable installation", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    await fs.writeFile(
      path.join(profile, "user.js"),
      'user_pref("browser.startup.page", 3);\n'
    );

    const result = await install({ profile, installRoot: zen });
    assert.equal(result.status, "installed");
    assert.equal(result.zenVersion, "1.23.4b");
    assert.match(result.backupDir, /svalinn-backup/);

    const state = await status({ profile, installRoot: zen });
    assert.equal(state.installed, true);
    assert.deepEqual(state.files, {
      bootloader: true,
      autoconfigPref: true,
      loader: true,
      adapter: true,
      css: true,
    });
    assert.equal(state.dragBehavior, "block");

    const managed = await readManagedState(profile);
    assert.equal(managed.hasManagedBlock, true);
    assert.equal(managed.enabled, true);
    assert.equal(managed.dragBehavior, "block");

    assert.match(
      await fs.readFile(path.join(profile, "user.js"), "utf8"),
      /browser\.startup\.page/
    );

    const css = await fs.readFile(
      path.join(profile, "chrome", "userChrome.css"),
      "utf8"
    );
    assert.match(css, /Svalinn managed CSS/);
    assert.match(css, /svalinn-active/);

    const uninstalled = await uninstall({ profile, installRoot: zen });
    assert.equal(uninstalled.status, "uninstalled");
    assert.equal((await status({ profile, installRoot: zen })).installed, false);
    assert.doesNotMatch(
      await fs.readFile(path.join(profile, "user.js"), "utf8"),
      /Svalinn managed preferences/
    );
    await assert.rejects(
      fs.access(path.join(profile, "chrome", "userChrome.css")),
      error => error.code === "ENOENT"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install refuses unverified Zen versions and autoconfig conflicts", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"), {
      version: "2.0.0",
    });
    const profile = await makeProfile(root);
    await fs.mkdir(path.join(zen, "defaults", "pref"), { recursive: true });
    await fs.writeFile(
      path.join(zen, "defaults", "pref", "other.js"),
      'pref("general.config.filename", "config.js");\n'
    );

    await assert.rejects(
      install({ profile, installRoot: zen }),
      /not a verified version/
    );
    await assert.rejects(
      install({
        profile,
        installRoot: zen,
        allowUnverifiedVersion: true,
      }),
      /Another autoconfig loader/
    );

    const overridden = await install({
      profile,
      installRoot: zen,
      allowUnverifiedVersion: true,
      force: true,
    });
    assert.equal(overridden.status, "installed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback restores user.js and removes newly installed files", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const originalUserJs =
      '// original\nuser_pref("browser.startup.page", 3);\n';
    await fs.writeFile(path.join(profile, "user.js"), originalUserJs);

    const result = await install({ profile, installRoot: zen });
    await fs.writeFile(
      path.join(profile, "user.js"),
      'user_pref("browser.startup.page", 1);\n'
    );

    const restored = await rollback({
      backupDir: result.backupDir,
      installRoot: zen,
      profile,
    });
    assert.equal(restored.status, "rolled-back");
    assert.equal(
      await fs.readFile(path.join(profile, "user.js"), "utf8"),
      originalUserJs
    );
    await assert.rejects(
      fs.access(path.join(zen, "svalinn.cfg")),
      error => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(profile, "chrome", "svalinn")),
      error => error.code === "ENOENT"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install supports the disabled managed state", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    await install({
      profile,
      installRoot: zen,
      enabled: false,
      dragBehavior: "duplicate",
    });
    const state = await readManagedState(profile);
    assert.equal(state.enabled, false);
    assert.equal(state.dragBehavior, "duplicate");
    const reported = await status({ profile, installRoot: zen });
    assert.equal(reported.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install preserves existing userChrome.css outside the managed block", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const cssPath = path.join(profile, "chrome", "userChrome.css");
    await fs.mkdir(path.dirname(cssPath), { recursive: true });
    await fs.writeFile(cssPath, "/* user custom CSS */\n.titlebar { color: red; }\n");

    await install({ profile, installRoot: zen });
    const installedCss = await fs.readFile(cssPath, "utf8");
    assert.match(installedCss, /user custom CSS/);
    assert.match(installedCss, /Svalinn managed CSS/);

    await uninstall({ profile, installRoot: zen });
    const restoredCss = await fs.readFile(cssPath, "utf8");
    assert.match(restoredCss, /user custom CSS/);
    assert.doesNotMatch(restoredCss, /Svalinn managed CSS/);
    assert.doesNotMatch(restoredCss, /svalinn-active/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reinstall/update keeps one managed block and creates a fresh backup", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const first = await install({ profile, installRoot: zen });
    const second = await install({
      profile,
      installRoot: zen,
      enabled: false,
    });
    assert.notEqual(first.backupDir, second.backupDir);
    const userJs = await fs.readFile(path.join(profile, "user.js"), "utf8");
    assert.equal(userJs.split(USERJS_START).length - 1, 1);
    assert.match(userJs, /user_pref\("svalinn\.enabled", false\);/);
    const backups = await fs.readdir(path.join(profile, "svalinn-backup"));
    assert.equal(backups.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
