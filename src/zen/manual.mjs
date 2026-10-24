#!/usr/bin/env node
/**
 * Launch a disposable Zen profile with the Svalinn adapter installed.
 *
 * This is for following docs/manual-zen-checklist.md by hand. It never uses
 * ~/.zen and removes a generated temporary profile when Zen exits.
 *
 * Usage: npm run zen:manual
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MarionetteClient } from "./marionette.mjs";
import { loadInjectionScript } from "./build.mjs";

const PREFS = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "browser.startup.page": 3,
  "browser.sessionstore.resume_from_crash": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "app.update.enabled": false,
  "zen.welcome-screen.seen": true,
  "zen.watermark.enabled": false,
  "svalinn.enabled": false,
  "toolkit.legacyUserProfileCustomizations.stylesheets": true,
  "privacy.userContext.enabled": true,
  "privacy.userContext.ui.enabled": true,
};

function parseArgs(argv) {
  const options = {
    zen: process.env.SVALINN_ZEN_BIN || "zen-browser",
    profile: null,
    keepProfile: false,
    port: 2828,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      return next;
    };
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--zen":
        options.zen = value();
        break;
      case "--profile":
        options.profile = value();
        break;
      case "--keep-profile":
        options.keepProfile = true;
        break;
      case "--port":
        options.port = Number(value());
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

function assertDisposable(profile) {
  const resolved = path.resolve(profile);
  const homeZen = path.resolve(path.join(os.homedir(), ".zen"));
  if (
    resolved === homeZen ||
    resolved.startsWith(`${homeZen}${path.sep}`)
  ) {
    throw new Error(
      `Refusing to use the daily Zen profile: ${resolved}`
    );
  }
}

async function prepareProfile(profile, port) {
  if (profile) {
    assertDisposable(profile);
    if (existsSync(profile)) {
      const entries = await fs.readdir(profile);
      if (entries.length) {
        throw new Error(`Profile directory is not empty: ${profile}`);
      }
    } else {
      await fs.mkdir(profile, { recursive: true });
    }
  } else {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "svalinn-manual-"));
  }

  await fs.writeFile(
    path.join(profile, "user.js"),
    Object.entries({ ...PREFS, "marionette.port": port })
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
      .join("\n")
  );

  const chromeDir = path.join(profile, "chrome");
  await fs.mkdir(chromeDir, { recursive: true });
  const cssSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../userChrome.css"
  );
  await fs.copyFile(cssSource, path.join(chromeDir, "userChrome.css"));
  return profile;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Svalinn manual Zen session

Usage: npm run zen:manual [-- options]

Options:
  --zen <path>        Zen binary (default: zen-browser or $SVALINN_ZEN_BIN)
  --profile <dir>     New/empty disposable profile directory
  --keep-profile      Keep a generated temporary profile after exit
  --port <n>          Marionette port (default: 2828)
  -h, --help          Show this help

The browser is launched with a disposable profile, the adapter is installed for
this session only, and no files are written to ~/.zen or /opt/zen-browser-bin.
Follow docs/manual-zen-checklist.md for the gesture matrix.
`);
    return;
  }

  const profile = await prepareProfile(options.profile, options.port);
  const generated = !options.profile;
  const child = spawn(
    options.zen,
    [
      "--profile",
      profile,
      "--marionette",
      "-remote-allow-system-access",
      "--no-remote",
      "--new-instance",
    ],
    { stdio: "inherit" }
  );

  let client;
  let verified = false;
  const cleanup = async () => {
    if (client) {
      if (verified) {
        try { await client.quit(); } catch {}
      }
      client.close();
      client = null;
    }
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
    if (generated && !options.keepProfile) {
      await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    client = await MarionetteClient.connect({
      port: options.port,
      retryTimeoutMs: 60_000,
    });
    const session = await client.newSession();
    if (path.resolve(session.capabilities["moz:profile"]) !== path.resolve(profile)) {
      throw new Error("Marionette connected to the wrong profile; aborting");
    }
    verified = true;
    await client.setContext("chrome");
    await client.execute(
      `const done = arguments[arguments.length - 1];
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
(async () => {
  await win.gZenStartup.promiseInitialized;
  await win.delayedStartupPromise;
  await SessionStore.promiseAllWindowsRestored;
  done({ ready: true, version: Services.appinfo.version });
})().catch(error => done({ error: String(error) }));`,
      { async: true, sandbox: "svalinn-manual", newSandbox: true, timeoutMs: 60_000 }
    );
    await client.execute(await loadInjectionScript(), {
      async: false,
      sandbox: "svalinn-manual",
      newSandbox: false,
    });
    const installed = await client.execute(
      `const done = arguments[arguments.length - 1];
globalThis.Svalinn.install({ enabled: true }).then(done, error => done({ error: String(error) }));`,
      { async: true, sandbox: "svalinn-manual", newSandbox: false, timeoutMs: 60_000 }
    );

    console.log(`\nSvalinn manual session`);
    console.log(`Zen: ${session.capabilities.browserVersion}`);
    console.log(`Profile: ${profile}`);
    console.log(`Adapter: ${installed.value?.status ?? "unknown"}`);
    console.log(`Guards: drop=${installed.value?.windows ?? 0} window(s)`);
    console.log(`\nFollow docs/manual-zen-checklist.md.`);
    console.log(`Close Zen or press Ctrl+C to end.\n`);

    await new Promise(resolve => {
      child.once("exit", resolve);
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
