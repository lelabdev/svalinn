import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REGISTRY_FILE,
  assertDisposableInstallRoot,
  install,
  resolveProfileTarget,
  rollback,
  status,
  uninstall,
} from "../src/zen/install-lib.mjs";
import {
  copyInstallation,
  parseArgs as parseInstalledSmokeArgs,
} from "../src/zen/installed-smoke.mjs";

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "svalinn-safety-test-"));
}

async function makeFakeZen(root, { version = "1.23.4b" } = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "application.ini"),
    `[App]\nName=Zen\nVersion=${version}\n`
  );
  const binary = path.join(root, "zen-bin");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n");
  await fs.chmod(binary, 0o755);
  return root;
}

async function makeProfile(root, name = "profile") {
  const profile = path.join(root, name);
  await fs.mkdir(profile, { recursive: true });
  return profile;
}

async function writeProfilesIni(container, entries) {
  const lines = ["[General]", "Version=2", ""];
  for (const [index, entry] of entries.entries()) {
    lines.push(`[Profile${index}]`);
    if (entry.name) lines.push(`Name=${entry.name}`);
    lines.push(`IsRelative=${entry.relative ? 1 : 0}`);
    lines.push(`Path=${entry.path}`);
    if (entry.default) lines.push("Default=1");
    lines.push("");
  }
  await fs.writeFile(path.join(container, "profiles.ini"), lines.join("\n"));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function backupDirs(profile) {
  try {
    return await fs.readdir(path.join(profile, "svalinn-backup"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readManifest(backupDir) {
  return JSON.parse(
    await fs.readFile(path.join(backupDir, "backup.json"), "utf8")
  );
}

test("profile containers resolve to the real default profile, never the container", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const container = path.join(root, ".zen");
    const profileA = path.join(container, "aaa.default");
    const profileB = path.join(container, "bbb.default");
    await fs.mkdir(profileA, { recursive: true });
    await fs.mkdir(profileB, { recursive: true });
    await writeProfilesIni(container, [
      { name: "default", relative: true, path: "aaa.default", default: true },
      { name: "other", relative: true, path: "bbb.default" },
    ]);

    const resolved = await resolveProfileTarget(container);
    assert.equal(resolved.profile, profileA);
    assert.equal(resolved.selectedBy, "profile-default");
    assert.equal(resolved.container, container);

    const result = await install({ profile: container, installRoot: zen });
    assert.equal(result.profile, profileA);
    assert.equal(result.profileContainer, container);
    assert.equal(await exists(path.join(container, "user.js")), false);
    assert.equal(await exists(path.join(container, "chrome")), false);
    assert.equal(await exists(path.join(profileA, "user.js")), true);
    assert.equal(await exists(path.join(profileB, "user.js")), false);

    const direct = await resolveProfileTarget(profileA);
    assert.equal(direct.profile, profileA);
    assert.equal(direct.container, null);

    const reported = await status({ profile: container, installRoot: zen });
    assert.equal(reported.profile, profileA);
    assert.equal(reported.profileContainer, container);
    assert.equal(reported.installed, true);
    assert.equal(reported.registered, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("profile containers honour [Install] defaults and reject ambiguity", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));

    const resolvedRoot = path.join(root, "resolved");
    const profileA = path.join(resolvedRoot, "one");
    const profileB = path.join(resolvedRoot, "two");
    await fs.mkdir(profileA, { recursive: true });
    await fs.mkdir(profileB, { recursive: true });
    await writeProfilesIni(resolvedRoot, [
      { name: "one", relative: true, path: "one" },
      { name: "two", relative: true, path: "two" },
    ]);
    await fs.appendFile(
      path.join(resolvedRoot, "profiles.ini"),
      "\n[Install4F96D1932A9F858E]\nDefault=two\nLocked=1\n"
    );
    const selected = await resolveProfileTarget(resolvedRoot);
    assert.equal(selected.profile, profileB);
    assert.equal(selected.selectedBy, "install-default");

    const ambiguous = path.join(root, "ambiguous");
    await fs.mkdir(path.join(ambiguous, "one"), { recursive: true });
    await fs.mkdir(path.join(ambiguous, "two"), { recursive: true });
    await writeProfilesIni(ambiguous, [
      { name: "one", relative: true, path: "one" },
      { name: "two", relative: true, path: "two" },
    ]);
    await assert.rejects(
      resolveProfileTarget(ambiguous),
      /several profiles and no unambiguous default/
    );
    await assert.rejects(
      install({ profile: ambiguous, installRoot: zen }),
      /several profiles and no unambiguous default/
    );
    assert.equal(await exists(path.join(ambiguous, "user.js")), false);

    const missing = path.join(root, "missing");
    await fs.mkdir(missing);
    await writeProfilesIni(missing, [
      { name: "gone", relative: true, path: "gone" },
    ]);
    await assert.rejects(
      resolveProfileTarget(missing),
      /profile directory does not exist/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uninstalling one profile keeps the shared bootloader for another", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profileA = await makeProfile(root, "a");
    const profileB = await makeProfile(root, "b");
    const originalA = 'user_pref("browser.startup.page", 3);\n';
    const originalB = 'user_pref("browser.startup.page", 1);\n';
    await fs.writeFile(path.join(profileA, "user.js"), originalA);
    await fs.writeFile(path.join(profileB, "user.js"), originalB);

    await install({ profile: profileA, installRoot: zen });
    await install({ profile: profileB, installRoot: zen });

    const stateB = await status({ profile: profileB, installRoot: zen });
    assert.equal(stateB.installed, true);
    assert.equal(stateB.registered, true);
    assert.equal(stateB.registeredProfiles, 2);

    const removedA = await uninstall({ profile: profileA, installRoot: zen });
    assert.equal(removedA.remainingProfiles, 1);
    assert.equal(removedA.sharedBootstrapRetained, true);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), true);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      true
    );

    const afterA = await status({ profile: profileB, installRoot: zen });
    assert.equal(afterA.installed, true);
    assert.equal(afterA.registeredProfiles, 1);
    assert.equal(await fs.readFile(path.join(profileA, "user.js"), "utf8"), originalA);
    assert.equal(await exists(path.join(profileA, "chrome", "svalinn")), false);
    assert.match(
      await fs.readFile(path.join(profileB, "user.js"), "utf8"),
      /Svalinn managed preferences/
    );

    const removedB = await uninstall({ profile: profileB, installRoot: zen });
    assert.equal(removedB.remainingProfiles, 0);
    assert.equal(removedB.sharedBootstrapRetained, false);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      false
    );
    assert.equal(await exists(path.join(zen, REGISTRY_FILE)), false);
    assert.equal(
      (await status({ profile: profileB, installRoot: zen })).installed,
      false
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rolling back one profile leaves another registered profile intact", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profileA = await makeProfile(root, "a");
    const profileB = await makeProfile(root, "b");
    const userJsB = 'user_pref("browser.startup.page", 1);\n';
    await fs.writeFile(path.join(profileB, "user.js"), userJsB);

    const installedA = await install({ profile: profileA, installRoot: zen });
    await install({ profile: profileB, installRoot: zen });
    const afterB = await status({ profile: profileB, installRoot: zen });
    assert.equal(afterB.registeredProfiles, 2);

    const rolledBack = await rollback({
      backupDir: installedA.backupDir,
      installRoot: zen,
      profile: profileA,
    });
    assert.equal(rolledBack.remainingProfiles, 1);
    assert.equal(rolledBack.sharedBootstrapRetained, true);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), true);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      true
    );

    const stateB = await status({ profile: profileB, installRoot: zen });
    assert.equal(stateB.installed, true);
    assert.equal(stateB.registered, true);
    assert.equal(stateB.registeredProfiles, 1);
    assert.match(
      await fs.readFile(path.join(profileB, "user.js"), "utf8"),
      /Svalinn managed preferences/
    );
    assert.equal(await exists(path.join(profileA, "chrome", "svalinn")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stale registrations are pruned without touching live profiles", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profileA = await makeProfile(root, "a");
    const profileB = await makeProfile(root, "b");
    await install({ profile: profileA, installRoot: zen });
    await install({ profile: profileB, installRoot: zen });

    await fs.rm(profileB, { recursive: true, force: true });
    const removed = await uninstall({ profile: profileA, installRoot: zen });
    assert.equal(removed.remainingProfiles, 0);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uncertain shared ownership is retained, not deleted", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    await install({ profile, installRoot: zen });

    const registryPath = path.join(zen, REGISTRY_FILE);
    await fs.writeFile(registryPath, "{ this is not json\n");
    const invalid = await uninstall({ profile, installRoot: zen });
    assert.equal(invalid.sharedBootstrapRetained, true);
    assert.match(invalid.warnings.join("\n"), /registry is invalid/i);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), true);

    await fs.rm(registryPath, { force: true });
    const legacy = await uninstall({ profile, installRoot: zen });
    assert.equal(legacy.sharedBootstrapRetained, true);
    assert.match(legacy.warnings.join("\n"), /ownership .* uncertain/i);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("foreign root files are never overwritten by filename alone", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const foreign = "// another loader owns this file\n";
    const userJs = 'user_pref("browser.startup.page", 3);\n';
    await fs.writeFile(path.join(zen, "svalinn.cfg"), foreign);
    await fs.writeFile(path.join(profile, "user.js"), userJs);

    await assert.rejects(
      install({ profile, installRoot: zen }),
      /already exist but were not created by Svalinn/
    );
    assert.equal(await fs.readFile(path.join(zen, "svalinn.cfg"), "utf8"), foreign);
    assert.equal(await exists(path.join(profile, "user.js")), true);
    assert.doesNotMatch(
      await fs.readFile(path.join(profile, "user.js"), "utf8"),
      /Svalinn managed preferences/
    );
    assert.equal(await exists(path.join(profile, "chrome", "svalinn")), false);
    assert.deepEqual(await backupDirs(profile), []);

    const installed = await install({ profile, installRoot: zen, force: true });
    const restored = await rollback({
      backupDir: installed.backupDir,
      installRoot: zen,
      profile,
    });
    assert.equal(restored.status, "rolled-back");
    assert.equal(await fs.readFile(path.join(zen, "svalinn.cfg"), "utf8"), foreign);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      false
    );
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), userJs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback rejects mismatched profile, installation root, paths and content", async () => {
  const root = await makeTempRoot();
  try {
    const zenA = await makeFakeZen(path.join(root, "zen-a"));
    const zenB = await makeFakeZen(path.join(root, "zen-b"));
    const profileA = await makeProfile(root, "a");
    const profileB = await makeProfile(root, "b");
    const userJsA = 'user_pref("browser.startup.page", 3);\n';
    const userJsB = 'user_pref("browser.startup.page", 1);\n';
    await fs.writeFile(path.join(profileA, "user.js"), userJsA);
    await fs.writeFile(path.join(profileB, "user.js"), userJsB);

    const installed = await install({ profile: profileA, installRoot: zenA });
    const installedUserJs = await fs.readFile(
      path.join(profileA, "user.js"),
      "utf8"
    );
    const manifestPath = path.join(installed.backupDir, "backup.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");

    await assert.rejects(
      rollback({
        backupDir: installed.backupDir,
        installRoot: zenB,
        profile: profileB,
      }),
      /Backup belongs to profile/
    );
    assert.equal(await fs.readFile(path.join(profileB, "user.js"), "utf8"), userJsB);
    assert.equal(await exists(path.join(zenB, "svalinn.cfg")), false);

    await assert.rejects(
      rollback({
        backupDir: installed.backupDir,
        installRoot: zenB,
        profile: profileA,
      }),
      /Backup belongs to installation/
    );
    assert.equal(await fs.readFile(path.join(profileB, "user.js"), "utf8"), userJsB);
    assert.equal(await exists(path.join(zenB, "svalinn.cfg")), false);

    const rewrite = async mutate => {
      const manifest = JSON.parse(originalManifest);
      mutate(manifest);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    await rewrite(manifest => {
      manifest.files.push({ base: "profile", relative: "../escape.txt", existed: false });
    });
    await assert.rejects(
      rollback({ backupDir: installed.backupDir, installRoot: zenA, profile: profileA }),
      /escapes its root/
    );

    await rewrite(manifest => {
      manifest.files.push({ base: "profile", relative: "/tmp/absolute.txt", existed: false });
    });
    await assert.rejects(
      rollback({ backupDir: installed.backupDir, installRoot: zenA, profile: profileA }),
      /unsafe path/
    );

    await rewrite(manifest => {
      manifest.files.push(manifest.files[0]);
    });
    await assert.rejects(
      rollback({ backupDir: installed.backupDir, installRoot: zenA, profile: profileA }),
      /duplicate record/
    );

    await fs.writeFile(manifestPath, originalManifest);
    await fs.rm(path.join(installed.backupDir, "profile", "user.js"));
    await assert.rejects(
      rollback({ backupDir: installed.backupDir, installRoot: zenA, profile: profileA }),
      /missing content/
    );
    assert.equal(
      await fs.readFile(path.join(profileA, "user.js"), "utf8"),
      installedUserJs
    );
    assert.equal(await exists(path.join(zenA, "svalinn.cfg")), true);

    await fs.writeFile(
      path.join(installed.backupDir, "profile", "user.js"),
      'user_pref("browser.startup.page", 9);\n'
    );
    await assert.rejects(
      rollback({ backupDir: installed.backupDir, installRoot: zenA, profile: profileA }),
      /hash check/
    );
    assert.equal(
      await fs.readFile(path.join(profileA, "user.js"), "utf8"),
      installedUserJs
    );
    assert.equal(await exists(path.join(zenA, "svalinn.cfg")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("update then rollback restores each recorded generation", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const original = '// original\nuser_pref("browser.startup.page", 3);\n';
    await fs.writeFile(path.join(profile, "user.js"), original);

    const first = await install({ profile, installRoot: zen, enabled: true });
    const second = await install({ profile, installRoot: zen, enabled: false });
    assert.equal(
      (await status({ profile, installRoot: zen })).enabled,
      false
    );

    await rollback({
      backupDir: second.backupDir,
      installRoot: zen,
      profile,
    });
    const afterSecond = await status({ profile, installRoot: zen });
    assert.equal(afterSecond.enabled, true);
    assert.equal(afterSecond.installed, true);

    await rollback({
      backupDir: first.backupDir,
      installRoot: zen,
      profile,
    });
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), original);
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);
    assert.equal(await exists(path.join(zen, REGISTRY_FILE)), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install preflight rejects a conflicting layout before any write", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const userJs = 'user_pref("browser.startup.page", 3);\n';
    await fs.writeFile(path.join(profile, "user.js"), userJs);
    await fs.writeFile(path.join(profile, "chrome"), "not a directory\n");

    await assert.rejects(
      install({ profile, installRoot: zen }),
      /chrome is not a directory/
    );
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      false
    );
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), userJs);
    assert.deepEqual(await backupDirs(profile), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed install restores every previously written file", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    const userJs = '// original\nuser_pref("browser.startup.page", 3);\n';
    await fs.writeFile(path.join(profile, "user.js"), userJs);

    await assert.rejects(
      install({
        profile,
        installRoot: zen,
        __testFailAt: "defaults/pref/svalinn-autoconfig.js",
      }),
      /Previous files were restored/
    );
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);
    assert.equal(
      await exists(path.join(zen, "defaults", "pref", "svalinn-autoconfig.js")),
      false
    );
    assert.equal(await exists(path.join(zen, REGISTRY_FILE)), false);
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), userJs);
    assert.equal(await exists(path.join(profile, "chrome", "svalinn")), false);
    assert.equal(await exists(path.join(profile, "chrome", "userChrome.css")), false);
    assert.deepEqual(await backupDirs(profile), []);

    await assert.rejects(
      install({ profile, installRoot: zen, __testFailAt: "user.js" }),
      /Previous files were restored/
    );
    assert.equal(await exists(path.join(profile, "chrome", "svalinn")), false);
    assert.equal(await exists(path.join(profile, "chrome", "userChrome.css")), false);
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), userJs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed update restores the previous working installation", async () => {
  const root = await makeTempRoot();
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    const profile = await makeProfile(root);
    await install({ profile, installRoot: zen, enabled: true });
    const beforeUserJs = await fs.readFile(path.join(profile, "user.js"), "utf8");
    const beforeCss = await fs.readFile(
      path.join(profile, "chrome", "userChrome.css"),
      "utf8"
    );
    const beforeBackups = await backupDirs(profile);

    await assert.rejects(
      install({
        profile,
        installRoot: zen,
        enabled: false,
        __testFailAt: "user.js",
      }),
      /Previous files were restored/
    );

    const state = await status({ profile, installRoot: zen });
    assert.equal(state.installed, true);
    assert.equal(state.enabled, true);
    assert.equal(state.registeredProfiles, 1);
    assert.equal(await fs.readFile(path.join(profile, "user.js"), "utf8"), beforeUserJs);
    assert.equal(
      await fs.readFile(path.join(profile, "chrome", "userChrome.css"), "utf8"),
      beforeCss
    );
    assert.deepEqual(await backupDirs(profile), beforeBackups);
    const manifest = await readManifest(
      path.join(profile, "svalinn-backup", beforeBackups[0])
    );
    assert.equal(manifest.status, "completed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installed-smoke copies its source and never mutates the caller tree", async () => {
  const root = await makeTempRoot();
  try {
    const source = await makeFakeZen(path.join(root, "zen"));
    await fs.writeFile(path.join(source, "marker.txt"), "source\n");
    const before = (await fs.readdir(source)).sort();

    const copied = await copyInstallation(source);
    try {
      const profile = await makeProfile(root, "copy-profile");
      await install({ profile, installRoot: copied.root.root });
      assert.equal(await exists(path.join(copied.root.root, "svalinn.cfg")), true);
      assert.equal(
        await exists(
          path.join(copied.root.root, "defaults", "pref", "svalinn-autoconfig.js")
        ),
        true
      );

      assert.equal(await exists(path.join(source, "svalinn.cfg")), false);
      assert.equal(
        await exists(path.join(source, "defaults", "pref", "svalinn-autoconfig.js")),
        false
      );
      assert.equal(await exists(path.join(source, REGISTRY_FILE)), false);
      assert.deepEqual((await fs.readdir(source)).sort(), before);
      assert.equal(
        await fs.readFile(path.join(source, "marker.txt"), "utf8"),
        "source\n"
      );
    } finally {
      await fs.rm(copied.copy, { recursive: true, force: true });
    }

    const alias = path.join(root, "zen-alias");
    await fs.symlink(source, alias);
    const aliasedCopy = await copyInstallation(alias);
    try {
      assert.equal(await exists(path.join(source, "svalinn.cfg")), false);
      await install({
        profile: await makeProfile(root, "alias-profile"),
        installRoot: aliasedCopy.root.root,
      });
      assert.equal(await exists(path.join(source, "svalinn.cfg")), false);
    } finally {
      await fs.rm(aliasedCopy.copy, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installed-smoke accepts an explicit headless flag and source root", () => {
  const options = parseInstalledSmokeArgs([
    "--install-root",
    "/tmp/source-zen",
    "--headless",
  ]);
  assert.equal(options.installRoot, "/tmp/source-zen");
  assert.equal(options.headless, true);
});

test("installed-smoke strips source Svalinn state from its copy", async () => {
  const root = await makeTempRoot();
  try {
    const source = await makeFakeZen(path.join(root, "zen"));
    await fs.mkdir(path.join(source, "defaults", "pref"), { recursive: true });
    await fs.writeFile(
      path.join(source, "svalinn.cfg"),
      "// Svalinn autoconfig bootloader.\nsource\n"
    );
    await fs.writeFile(
      path.join(source, "defaults", "pref", "svalinn-autoconfig.js"),
      '// Svalinn managed autoconfig entry point.\npref("general.config.filename", "svalinn.cfg");\n'
    );
    await fs.writeFile(
      path.join(source, REGISTRY_FILE),
      `${JSON.stringify({
        schema: 1,
        managedBy: "svalinn",
        installRoot: source,
        profiles: [],
      })}\n`
    );

    const copied = await copyInstallation(source);
    try {
      for (const relative of [
        "svalinn.cfg",
        "defaults/pref/svalinn-autoconfig.js",
        REGISTRY_FILE,
      ]) {
        assert.equal(await exists(path.join(copied.root.root, relative)), false);
        assert.equal(await exists(path.join(source, relative)), true);
      }
    } finally {
      await fs.rm(copied.copy, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the smoke harness refuses to install into a live Zen root", async () => {
  const root = await makeTempRoot();
  const previous = process.env.SVALINN_ZEN_ROOT;
  try {
    const zen = await makeFakeZen(path.join(root, "zen"));
    process.env.SVALINN_ZEN_ROOT = zen;
    await assert.rejects(
      assertDisposableInstallRoot(zen),
      /live Zen installation/
    );
    assert.equal(await exists(path.join(zen, "svalinn.cfg")), false);

    const copied = await copyInstallation(zen);
    try {
      assert.equal(await assertDisposableInstallRoot(copied.root.root), copied.root.root);
    } finally {
      await fs.rm(copied.copy, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.SVALINN_ZEN_ROOT;
    else process.env.SVALINN_ZEN_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
