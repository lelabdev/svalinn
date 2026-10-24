#!/usr/bin/env node
/**
 * Run the full Zen smoke suite against a persistent Svalinn installation.
 *
 * A copy of the Zen installation directory is used by default, so the real
 * /opt tree is never modified. The copied profile is disposable, and the first
 * startup is verified without Marionette before the normal smoke checks run.
 *
 * Usage: npm run zen:installed-smoke
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGISTRY_FILE,
  SHARED_FILES,
  inspectInstallRoot,
  install as installPersistent,
} from "./install-lib.mjs";
import { preflightInstalledStartup, runSmoke } from "./smoke.mjs";

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    zenRoot: process.env.SVALINN_ZEN_ROOT || "/opt/zen-browser-bin",
    installRoot: null,
    profile: null,
    keep: false,
    headless: true,
    json: false,
    skipRestart: false,
    skipPreflight: false,
    port: 2828,
    timeoutMs: 60_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--zen-root":
        options.zenRoot = requireValue(argv, ++index, arg);
        break;
      case "--install-root":
        options.installRoot = requireValue(argv, ++index, arg);
        break;
      case "--profile":
        options.profile = requireValue(argv, ++index, arg);
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--skip-restart":
        options.skipRestart = true;
        break;
      case "--skip-preflight":
        options.skipPreflight = true;
        break;
      case "--port":
        options.port = Number(requireValue(argv, ++index, arg));
        break;
      case "--timeout":
        options.timeoutMs = Number(requireValue(argv, ++index, arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function usage() {
  console.log(`Svalinn persistent installation smoke test

Usage:
  npm run zen:installed-smoke
  node src/zen/installed-smoke.mjs [options]

Options:
  --zen-root <dir>     Zen installation to copy (default: /opt/zen-browser-bin)
  --install-root <dir> Zen installation to copy, instead of --zen-root
  --profile <dir>      New/empty disposable profile directory
  --keep               Keep the copied installation and generated profile
  --headed             Run with a visible window (default: headless)
  --skip-restart       Skip session restore/restart checks
  --skip-preflight     Skip the no-Marionette installed and disabled checks
  --port <n>           Marionette port for the test phase (default: 2828)
  --timeout <ms>       Startup/connect timeout (default: 60000)
  --json               Print the complete report as JSON
  -h, --help           Show this help

The source installation directory is never modified: it is always copied into
a disposable temporary location, and Svalinn is installed only in the copy. The
real /opt installation and ~/.zen profile are never used. Zen is started without
a debug port before the standard smoke checks run.
`);
}

/**
 * Copy a Zen installation tree to a disposable location.
 *
 * Callers must treat the source as read-only. Exported for regression tests
 * that verify the source is byte-for-byte unchanged.
 */
export async function copyInstallation(source) {
  const inspected = await inspectInstallRoot(source);
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), "svalinn-zen-install-"));
  await fs.cp(inspected.root, copy, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });

  // The source may already have Svalinn installed. The smoke test must start
  // from a clean installation root, so never carry Svalinn's shared bootloader
  // or registry (which records the source root) into the disposable copy.
  for (const relative of [...SHARED_FILES, REGISTRY_FILE]) {
    await fs.rm(path.join(copy, relative), { force: true });
  }

  return {
    copy,
    root: await inspectInstallRoot(copy),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return null;
  }

  let temporaryCopy = null;
  let installRoot = null;
  let zenRoot = null;
  try {
    // Always copy, even when --install-root is supplied. The argument names a
    // source tree, never a writable target; this keeps the harness
    // non-destructive by construction.
    const source = options.installRoot ?? options.zenRoot;
    const copied = await copyInstallation(source);
    temporaryCopy = copied.copy;
    zenRoot = copied.root;
    installRoot = copied.root.root;

    const report = await runSmoke({
      zen: zenRoot.binary,
      profile: options.profile,
      keepProfile: options.keep,
      headless: options.headless,
      port: options.port,
      timeoutMs: options.timeoutMs,
      json: options.json,
      skipRestart: options.skipRestart,
      installed: true,
      installRoot,
      skipPreflight: options.skipPreflight,
    });

    if (report.ok && !options.skipPreflight) {
      await installPersistent({
        profile: report.profile,
        installRoot,
        enabled: false,
      });
      const disabled = await preflightInstalledStartup(
        {
          ...options,
          zen: zenRoot.binary,
        },
        report.profile
      );
      const disabledCheck = {
        name: "installed-disabled-startup-without-marionette",
        ok:
          disabled.exited === true &&
          disabled.status === "disabled" &&
          disabled.windows === 0 &&
          !disabled.lastError,
        details: disabled,
      };
      report.checks.push(disabledCheck);
      report.ok = report.checks.every(check => check.ok);

      // Leave the disposable profile enabled for inspection.
      await installPersistent({
        profile: report.profile,
        installRoot,
        enabled: true,
      });
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("");
      for (const [index, check] of report.checks.entries()) {
        console.log(`${index + 1}. ${check.ok ? "PASS" : "FAIL"} ${check.name}`);
      }
      if (report.error) console.log(`\nError (${report.phase}): ${report.error}`);
      if (report.diagnostics) {
        console.log(`\nZen output:\n${report.diagnostics}`);
      }
      if (report.warnings?.length) {
        console.log(`\nWarnings:\n- ${report.warnings.join("\n- ")}`);
      }
      console.log(
        `\nResult: ${report.ok ? "PASS" : "FAIL"} (${report.durationMs} ms)`
      );
    }
    return report;
  } finally {
    if (temporaryCopy && !options.keep) {
      await fs.rm(temporaryCopy, { recursive: true, force: true });
    } else if (temporaryCopy) {
      console.log(`Installation copy kept at ${temporaryCopy}`);
    }
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then(report => {
      if (report && report.ok === false) process.exitCode = 1;
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
