#!/usr/bin/env node
/**
 * Svalinn personal installer.
 *
 * Installs a tiny autoconfig bootloader into Zen's installation directory and
 * the trusted loader/adapter into a profile. No Marionette or debug port is
 * used during normal browsing.
 *
 * Usage:
 *   npm run zen:install -- --profile /path/to/profile
 *   npm run zen:install -- --profile ~/.zen --confirm-daily
 *   npm run zen:install -- --command uninstall --profile ...
 *   npm run zen:install -- --command rollback --profile ... [--backup DIR]
 *   npm run zen:install -- --command status --profile ...
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectInstallRoot,
  install,
  rollback,
  status,
  uninstall,
  InstallError,
} from "./install-lib.mjs";
import {
  isPathInside,
  realpathAllowMissing,
} from "./profile.mjs";

function usage() {
  console.log(`Svalinn personal installer

Usage:
  npm run zen:install -- --profile <profile> [options]

Commands (--command <name>):
  install     Install/update the loader and adapter (default)
  update      Alias for install; creates a new backup
  uninstall   Remove the loader, profile assets and managed prefs
  rollback    Restore the latest or selected backup
  status      Report installation state

Options:
  --profile <dir>           Zen profile directory (required)
  --confirm-daily           Required when --profile is ~/.zen or inside it
  --install-root <dir>      Zen installation root (default: auto-detect)
  --backup <dir>            Backup directory for rollback
  --enabled / --disabled    Managed svalinn.enabled value (default enabled)
  --drag-behavior <mode>    block (default) or duplicate
  --allow-unverified-version  Allow installation outside Zen 1.23.x
  --force                   Replace an existing autoconfig loader
  --json                    Machine-readable result
  -h, --help                Show this help

The installer never edits tabs/session data and never runs Zen. Installation
directory changes are limited to two small files and require write permission.
`);
}

function parseArgs(argv) {
  const options = {
    command: "install",
    profile: null,
    confirmDaily: false,
    installRoot: null,
    backup: null,
    enabled: true,
    dragBehavior: "block",
    allowUnverifiedVersion: false,
    force: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) {
        throw new InstallError(`${arg} requires a value`);
      }
      return next;
    };
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--command":
        options.command = value();
        break;
      case "--profile":
        options.profile = value();
        break;
      case "--confirm-daily":
        options.confirmDaily = true;
        break;
      case "--install-root":
        options.installRoot = value();
        break;
      case "--backup":
        options.backup = value();
        break;
      case "--enabled":
        options.enabled = true;
        break;
      case "--disabled":
        options.enabled = false;
        break;
      case "--drag-behavior":
        options.dragBehavior = value();
        break;
      case "--allow-unverified-version":
        options.allowUnverifiedVersion = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new InstallError(`Unknown argument: ${arg}`);
    }
  }
  if (!["install", "update", "uninstall", "rollback", "status"].includes(options.command)) {
    throw new InstallError(`Unknown command: ${options.command}`);
  }
  if (!["block", "duplicate"].includes(options.dragBehavior)) {
    throw new InstallError("--drag-behavior must be block or duplicate");
  }
  return options;
}

async function assertDailyConfirmation(profile, confirmDaily) {
  const resolved = await realpathAllowMissing(profile);
  const home = process.env.SUDO_USER
    ? path.join("/home", process.env.SUDO_USER)
    : os.homedir();
  const homeZen = await realpathAllowMissing(path.join(home, ".zen"));
  if (isPathInside(resolved, homeZen) && !confirmDaily) {
    throw new InstallError(
      `Refusing to modify the daily profile without --confirm-daily: ${resolved}. ` +
        "Test in a disposable profile first."
    );
  }
}

async function chownTree(target, uid, gid) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await chownTree(path.join(target, entry), uid, gid);
    }
  }
  await fs.chown(target, uid, gid);
}

async function restoreUserOwnership(profile) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  for (const target of [
    path.join(profile, "user.js"),
    path.join(profile, "chrome"),
    path.join(profile, "svalinn-backup"),
  ]) {
    await chownTree(target, uid, gid);
  }
  await fs.chown(profile, uid, gid).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function latestBackup(profile) {
  const root = path.join(profile, "svalinn-backup");
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const manifestPath = path.join(dir, "backup.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      candidates.push({ dir, createdAt: manifest.createdAt ?? entry });
    } catch {
      candidates.push({ dir, createdAt: entry });
    }
  }
  candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return candidates.at(-1)?.dir ?? null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.profile) {
    throw new InstallError("--profile is required");
  }
  await assertDailyConfirmation(options.profile, options.confirmDaily);

  let installation = null;
  if (!options.installRoot) {
    installation = await detectInstallRoot();
  }
  const installRoot = options.installRoot
    ? path.resolve(options.installRoot)
    : installation.root;

  let result;
  if (options.command === "install" || options.command === "update") {
    result = await install({
      profile: options.profile,
      installRoot,
      enabled: options.enabled,
      dragBehavior: options.dragBehavior,
      allowUnverifiedVersion: options.allowUnverifiedVersion,
      force: options.force,
    });
  } else if (options.command === "uninstall") {
    result = await uninstall({
      profile: options.profile,
      installRoot,
    });
  } else if (options.command === "rollback") {
    const backupDir =
      options.backup ?? (await latestBackup(options.profile));
    if (!backupDir) throw new InstallError("No Svalinn backup found");
    result = await rollback({
      backupDir,
      installRoot,
      profile: options.profile,
    });
  } else {
    result = await status({
      profile: options.profile,
      installRoot,
    });
  }

  if (options.command !== "status") {
    await restoreUserOwnership(path.resolve(options.profile));
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const [key, value] of Object.entries(result)) {
      console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
  }
}

main().catch(error => {
  console.error(`Svalinn install: ${error.message}`);
  process.exitCode = 1;
});
