#!/usr/bin/env node
/**
 * Svalinn smoke test for Zen Browser.
 *
 * Launches Zen with a disposable profile, injects the read-only adapter through
 * Marionette's chrome context (or uses a persistently installed loader with
 * `--installed`), creates normal/Pinned/Essential tabs, verifies the mapping,
 * checks install/uninstall/disabled behaviour, restarts and verifies session
 * restore, then shuts down and removes the profile.
 *
 * Usage: npm run zen:smoke
 * See docs/zen-integration.md for flags and safety notes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MarionetteClient } from "./marionette.mjs";
import { loadInjectionScript } from "./build.mjs";
import {
  assertDisposableProfile,
  sameRealPath,
} from "./profile.mjs";
import { assertDisposableInstallRoot, detectInstallRoot, install as installPersistent } from "./install-lib.mjs";

const SANDBOX = "svalinn-smoke";
const DEFAULT_TIMEOUT_MS = 60_000;
const PROFILE_PREF_VERSION = 1;

const PROFILE_PREFS = {
  "marionette.port": null, // filled by the caller
  "marionette.log.level": "Info",
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "browser.startup.page": 3,
  "browser.sessionstore.resume_from_crash": false,
  "browser.sessionstore.interval": 1000,
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

export class SmokeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SmokeError";
    this.details = details;
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    zen: process.env.SVALINN_ZEN_BIN || "zen-browser",
    profile: null,
    keepProfile: false,
    headless: false,
    port: 2828,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    skipRestart: false,
    installed: false,
    installRoot: null,
    skipPreflight: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--zen":
        options.zen = requireValue(argv, ++index, arg);
        break;
      case "--profile":
        options.profile = requireValue(argv, ++index, arg);
        break;
      case "--keep-profile":
        options.keepProfile = true;
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
      case "--installed":
        options.installed = true;
        break;
      case "--install-root":
        options.installRoot = requireValue(argv, ++index, arg);
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
        throw new SmokeError(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isInteger(options.port) ||
    options.port <= 0 ||
    options.port > 65535
  ) {
    throw new SmokeError("--port must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new SmokeError("--timeout must be a positive integer");
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new SmokeError(`${flag} requires a value`);
  }
  return value;
}

function profilePreferences(port) {
  const prefs = { ...PROFILE_PREFS, "marionette.port": port };
  return Object.entries(prefs)
    .map(
      ([name, value]) =>
        `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`
    )
    .join("\n");
}

/**
 * Create the disposable profile and its smoke pages.
 *
 * @param {object} options
 * @returns {Promise<{ profile: string, urls: Record<string, string>, created: boolean }>}
 */
async function prepareProfile({ profile, port }) {  let created = false;
  if (profile) {
    await assertDisposableProfile(profile);
    if (existsSync(profile)) {
      const entries = await fs.readdir(profile);
      if (entries.length) {
        let marker = null;
        try {
          marker = JSON.parse(
            await fs.readFile(
              path.join(profile, "svalinn-profile.json"),
              "utf8"
            )
          );
        } catch {
          marker = null;
        }
        if (marker?.generatedBy !== "Svalinn smoke test") {
          throw new SmokeError(
            `Profile directory is not empty and was not generated by this test: ${profile}`
          );
        }
      }
    } else {
      await fs.mkdir(profile, { recursive: true });
      created = true;
    }
  } else {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "svalinn-zen-"));
    created = true;
  }

  await assertDisposableProfile(profile);

  await fs.writeFile(
    path.join(profile, "user.js"),
    `// Generated by Svalinn smoke test.\n${profilePreferences(port)}\n`
  );

  const chromeDir = path.join(profile, "chrome");
  await fs.mkdir(chromeDir, { recursive: true });
  const cssSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../userChrome.css"
  );
  await fs.copyFile(cssSource, path.join(chromeDir, "userChrome.css"));

  const urls = {};
  for (const zone of ["normal", "pinned", "essential"]) {
    const file = path.join(profile, `svalinn-${zone}.html`);
    await fs.writeFile(
      file,
      `<!doctype html><meta charset="utf-8"><title>Svalinn ${zone}</title>` +
        `<p data-svalinn-zone="${zone}">Svalinn smoke tab: ${zone}</p>\n`
    );
    urls[zone] = pathToFileURL(file).href;
  }

  await fs.writeFile(
    path.join(profile, "svalinn-profile.json"),
    JSON.stringify({ generatedBy: "Svalinn smoke test", prefsVersion: PROFILE_PREF_VERSION }, null, 2)
  );

  return { profile, urls, created };
}

class ZenProcess {
  constructor(binary, args, options) {
    this.binary = binary;
    this.args = args;
    this.timeoutMs = options.timeoutMs;
    this.output = [];
    this.exited = false;
    this.exitInfo = null;
    this.child = null;
  }

  start() {
    this.child = spawn(this.binary, this.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
    });
    this.child.stdout.on("data", chunk => this.capture(chunk));
    this.child.stderr.on("data", chunk => this.capture(chunk));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
    });
    return this;
  }

  capture(chunk) {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    this.output.push(...lines);
    if (this.output.length > 400) this.output.splice(0, this.output.length - 400);
  }

  async waitForExit(timeoutMs = 20_000) {
    if (this.exited) return this.exitInfo;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmokeError("Zen did not exit within the timeout"));
      }, timeoutMs);
      this.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  async stop() {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    try {
      await this.waitForExit(5_000);
    } catch {
      this.child.kill("SIGKILL");
      await this.waitForExit(5_000).catch(() => {});
    }
  }

  diagnostics() {
    return this.output.slice(-30).join("\n");
  }
}

function zenArgs({ profile, port, headless }) {
  return [
    "--profile",
    profile,
    "--marionette",
    "-remote-allow-system-access",
    "--no-remote",
    "--new-instance",
    ...(headless ? ["--headless"] : []),
  ];
}

function installedStartupArgs({ profile, headless }) {
  return [
    "--profile",
    profile,
    "--no-remote",
    "--new-instance",
    ...(headless ? ["--headless"] : []),
  ];
}

export async function preflightInstalledStartup(options, profile) {
  const child = new ZenProcess(
    options.zen,
    installedStartupArgs({ profile, headless: options.headless }),
    options
  ).start();
  const waitMs = Math.min(options.timeoutMs, 15_000);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  await child.stop();
  const prefs = await fs
    .readFile(path.join(profile, "prefs.js"), "utf8")
    .catch(() => "");
  const stringPref = name => {
    const match = prefs.match(
      new RegExp(`user_pref\\("${name.replace(/[.]/g, "\\.")}",\\s*"([^"]*)"\\);`)
    );
    return match?.[1] ?? null;
  };
  const intPref = name => {
    const match = prefs.match(
      new RegExp(`user_pref\\("${name.replace(/[.]/g, "\\.")}",\\s*(\\d+)\\);`)
    );
    return match ? Number(match[1]) : null;
  };
  return {
    exited: child.exited,
    status: stringPref("svalinn.status"),
    loaderVersion: stringPref("svalinn.loaderVersion"),
    lastError: stringPref("svalinn.lastError"),
    windows: intPref("svalinn.guardWindows"),
    output: child.diagnostics(),
  };
}

async function connectAndVerify({ client, profile, port, child }) {
  const session = await client.newSession();
  const capabilities = session?.capabilities ?? {};
  const remoteProfile = capabilities["moz:profile"];
  if (!remoteProfile) {
    throw new SmokeError(
      "Marionette session did not report moz:profile; aborting before chrome access"
    );
  }
  const sameProfile = await sameRealPath(remoteProfile, profile);
  if (!sameProfile) {
    throw new SmokeError(
      `Refusing to drive the wrong browser: connected profile ${remoteProfile} ` +
        `does not match ${profile}. Is port ${port} already used by another Zen?`
    );
  }

  await client.setContext("chrome");
  return {
    version: capabilities.browserVersion ?? null,
    processID: capabilities["moz:processID"] ?? null,
    pidMatches: capabilities["moz:processID"] === child?.pid,
    profile: remoteProfile,
  };
}

function wrapChromeScript(body) {
  return `
const done = arguments[arguments.length - 1];
(async () => {
${body}
})().then(
  value => done(value),
  error => done({ __svalinnError: String(error), stack: error?.stack ?? null })
);`;
}

function adapterPrelude(body) {
  return `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
if (!win) throw new Error("no browser window");
const hidden = (() => {
  try { return Services.appShell.hiddenDOMWindow; } catch { return null; }
})();
const api = globalThis.Svalinn ?? win.Svalinn ?? hidden?.Svalinn;
if (!api) throw new Error("Svalinn adapter is not injected");
${body}`;
}

async function runScript(client, body, { timeoutMs = 60_000 } = {}) {
  const result = await client.execute(wrapChromeScript(body), {
    async: true,
    sandbox: SANDBOX,
    newSandbox: false,
    timeoutMs,
  });
  const value = result?.value;
  if (value && value.__svalinnError) {
    throw new SmokeError(value.__svalinnError, value.stack);
  }
  return value;
}

async function runAdapter(client, body, options = {}) {
  return runScript(client, adapterPrelude(body), options);
}

async function ensureAdapter(client, timeoutMs, { installed = false } = {}) {
  if (installed) {
    const waitMs = Math.min(timeoutMs, 45_000);
    const present = await runScript(
      client,
      `
const getApi = () => {
  if (globalThis.Svalinn) return globalThis.Svalinn;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.Svalinn) return win.Svalinn;
  }
  try {
    return Services.appShell.hiddenDOMWindow?.Svalinn ?? null;
  } catch {
    return null;
  }
};
const deadline = Date.now() + ${waitMs};
let api = getApi();
while (!api && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100));
  api = getApi();
}
if (!api) return { present: false };
globalThis.Svalinn = api;
return {
  present: true,
  adapter: api.version ?? null,
  marker: api.marker ?? null,
  policy: Object.keys(api.policy ?? {}),
  installed: Boolean(api.snapshot?.().installed),
  status: Services.prefs.getStringPref("svalinn.status", ""),
  loaderVersion: Services.prefs.getStringPref("svalinn.loaderVersion", ""),
  windows: Services.prefs.getIntPref("svalinn.guardWindows", 0),
};
`,
      { timeoutMs: waitMs + 10_000 }
    );
    if (!present?.present) {
      throw new SmokeError("Installed Svalinn loader did not expose the adapter");
    }
    return present;
  }

  const present = await runScript(
    client,
    `return typeof globalThis.Svalinn === "object" && globalThis.Svalinn !== null;`,
    { timeoutMs }
  );
  if (!present) {
    const script = await loadInjectionScript();
    await client.execute(script, {
      async: false,
      sandbox: SANDBOX,
      newSandbox: false,
      timeoutMs,
    });
  }
  return runScript(
    client,
    `return {
      adapter: globalThis.Svalinn?.version ?? null,
      marker: globalThis.Svalinn?.marker ?? null,
      policy: Object.keys(globalThis.Svalinn?.policy ?? {}),
    };`,
    { timeoutMs }
  );
}

async function waitForZenReady(client, timeoutMs) {
  const waitMs = Math.min(timeoutMs, 45_000);
  const result = await runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
if (!win) return { ready: false, reason: "no-window" };
const deadline = Date.now() + ${waitMs};
while (Date.now() < deadline) {
  if (win.gZenStartup?.isReady) {
    await Promise.race([
      Promise.allSettled([
        win.delayedStartupPromise,
        SessionStore.promiseAllWindowsRestored,
      ]),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    return {
      ready: true,
      isReady: Boolean(win.gZenStartup.isReady),
      version: Services.appinfo.version,
      app: Services.appinfo.name,
      windows: [...Services.wm.getEnumerator("navigator:browser")].length,
    };
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}
return { ready: false, reason: "timeout", app: Services.appinfo.name };
`,
    { timeoutMs: waitMs + 10_000 }
  );
  if (!result?.ready) {
    throw new SmokeError(
      `Zen did not become ready: ${JSON.stringify(result)}`
    );
  }
  return result;
}

async function createSmokeTabs(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const gBrowser = win.gBrowser;
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const urls = ${JSON.stringify(urls)};

const findByUrl = url =>
  [...gBrowser.tabs].find(tab => tab.linkedBrowser?.currentURI?.spec === url);

const ensure = async url => {
  let tab = findByUrl(url);
  if (!tab) {
    tab = gBrowser.addTab(url, { triggeringPrincipal: principal, inBackground: true });
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return tab;
};

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + label);
};

const normal = await ensure(urls.normal);
const pinned = await ensure(urls.pinned);
if (!pinned.pinned) gBrowser.pinTab(pinned);
await waitFor(() => pinned.pinned, "pinned tab");

const essential = await ensure(urls.essential);
if (!essential.pinned) gBrowser.pinTab(essential);
await waitFor(() => essential.pinned, "essential tab pin");
if (!essential.hasAttribute("zen-essential")) {
  win.gZenPinnedTabManager.addToEssentials(essential);
}
await waitFor(
  () => essential.hasAttribute("zen-essential"),
  "essential tab attribute"
);

await new Promise(resolve => setTimeout(resolve, 400));

return {
  tabs: [...gBrowser.tabs].map(tab => ({
    id: tab.id,
    pinned: Boolean(tab.pinned),
    essential: tab.hasAttribute("zen-essential"),
    url: tab.linkedBrowser?.currentURI?.spec ?? null,
  })),
};`,
    { timeoutMs: 30_000 }
  );
}

async function runDropScenarios(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const api = globalThis.Svalinn;
const gBrowser = win.gBrowser;
const manager = win.gZenPinnedTabManager;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const zone = tab =>
  tab.hasAttribute("zen-essential")
    ? "essential"
    : tab.pinned
      ? "pinned"
      : "normal";
const tabsInclude = tab => [...gBrowser.tabs].includes(tab);
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const base = ${JSON.stringify(urls.normal)};
let seq = 0;

const makeTab = async ({ pinned = false, essential = false, url = null } = {}) => {
  const tab = gBrowser.addTab(url ?? base + "#drop-" + ++seq, {
    triggeringPrincipal: principal,
    inBackground: true,
  });
  await wait(80);
  if (pinned || essential) gBrowser.pinTab(tab);
  await wait(60);
  if (essential) manager.addToEssentials(tab);
  await wait(120);
  return tab;
};

const dispatchDrop = (
  source,
  target,
  movingTabs = [source],
  extraDragData = {}
) => {
  source._dragData = {
    movingTabs,
    movingTabsSet: new Set(movingTabs),
    fromTabList: false,
    dropElement: target,
    dropBefore: true,
    translateX: (target.screenX ?? 0) - (source.screenX ?? 0),
    translateY: (target.screenY ?? 0) - (source.screenY ?? 0),
    tabWidth: source.getBoundingClientRect().width || 200,
    tabHeight: source.getBoundingClientRect().height || 30,
    ...extraDragData,
  };
  const dataTransfer = new win.DataTransfer();
  dataTransfer.mozSetDataAt(win.TAB_DROP_TYPE, source, 0);
  dataTransfer.dropEffect = "move";
  const rect = target.getBoundingClientRect();
  const event = new win.DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    screenX: (target.screenX ?? rect.left) + rect.width / 2,
    screenY: (target.screenY ?? rect.top) + rect.height / 2 + 2,
  });
  target.dispatchEvent(event);
};

const dropTab = async (source, target, movingTabs = [source]) => {
  dispatchDrop(source, target, movingTabs);
  await wait(300);
};

const results = [];
const check = (name, ok, details) => results.push({ name, ok, details });
const addedSince = before => [...gBrowser.tabs].filter(tab => !before.has(tab));

const duplicateScenario = async (name, source, target, expectedZone) => {
  const before = new Set(gBrowser.tabs);
  const sourceZone = zone(source);
  await dropTab(source, target);
  const deadline = Date.now() + 8000;
  let added = addedSince(before);
  while (
    Date.now() < deadline &&
    !(added.length === 1 && zone(added[0]) === expectedZone && added[0].selected)
  ) {
    await wait(50);
    added = addedSince(before);
  }
  check(
    name,
    added.length === 1 &&
      zone(source) === sourceZone &&
      zone(added[0]) === expectedZone &&
      added[0].selected === true &&
      (added[0].userContextId ?? 0) === (source.userContextId ?? 0),
    {
      added: added.length,
      sourceZone: zone(source),
      expectedSourceZone: sourceZone,
      copyZone: added[0] ? zone(added[0]) : null,
      expectedCopyZone: expectedZone,
      copySelected: added[0] ? added[0].selected : null,
      targetZone: zone(target),
      sourceUserContextId: source.userContextId ?? 0,
      copyUserContextId: added[0]?.userContextId ?? 0,
    }
  );
};

const blockedScenario = async (name, source, target, expectedZone) => {
  const before = new Set(gBrowser.tabs);
  await dropTab(source, target);
  const added = addedSince(before);
  check(
    name,
    added.length === 0 && zone(source) === expectedZone,
    {
      added: added.length,
      sourceZone: zone(source),
      expectedSourceZone: expectedZone,
    }
  );
};

const nativeScenario = async (name, source, target, expectedSourceZone) => {
  const before = new Set(gBrowser.tabs);
  await dropTab(source, target);
  const added = addedSince(before);
  check(
    name,
    added.length === 0 && zone(source) === expectedSourceZone,
    {
      added: added.length,
      sourceZone: zone(source),
      expectedSourceZone,
    }
  );
};

const normalA = await makeTab({ pinned: false });
const normalB = await makeTab({ pinned: false });
const pinnedA = await makeTab({ pinned: true });
const pinnedB = await makeTab({ pinned: true });
const essentialA = await makeTab({ essential: true });
const essentialB = await makeTab({ essential: true });

// Default mode: block category-changing drags without copies or source changes.
await blockedScenario("drag-block-essential-to-normal", essentialA, normalA, "essential");
await blockedScenario("drag-block-pinned-to-normal", pinnedA, normalA, "pinned");
await blockedScenario("drag-block-pinned-to-essential", pinnedB, essentialB, "pinned");
await blockedScenario("drag-block-essential-to-pinned", essentialB, pinnedB, "essential");

// Same-category reordering and normal tabs remain native in block mode.
await nativeScenario("drag-same-zone-native", pinnedA, pinnedB, "pinned");
await nativeScenario("drag-normal-native", normalB, pinnedB, "pinned");

// Multi-selected protected tabs crossing zones are blocked; same-zone reorder is native.
const beforeMulti = new Set(gBrowser.tabs);
await dropTab(pinnedA, normalA, [pinnedA, pinnedB]);
check(
  "drag-multi-cross-zone-blocked",
  addedSince(beforeMulti).length === 0 &&
    zone(pinnedA) === "pinned" &&
    zone(pinnedB) === "pinned",
  {
    added: addedSince(beforeMulti).length,
    firstZone: zone(pinnedA),
    secondZone: zone(pinnedB),
  }
);
await nativeScenario("drag-multi-same-zone-native", pinnedA, pinnedB, "pinned");

// Folder-contained protected tab can be reorganized inside the pinned category.
const folderSource = await makeTab({ pinned: true });
win.gZenFolders.createFolder([folderSource]);
await wait(600);
await nativeScenario("drag-folder-same-zone-native", folderSource, pinnedB, "pinned");

// Cross-window protected drag is blocked before native adoption/demotion.
const second = win.OpenBrowserWindow();
await new Promise(resolve => second.addEventListener("load", resolve, { once: true }));
const secondReady = Date.now() + 5000;
while (
  Date.now() < secondReady &&
  !(
    second.__svalinn &&
    second.gBrowser?.["__svalinnCloseHook"] &&
    second.gBrowser?.tabContainer?.tabDragAndDrop?.["__svalinnDropHook"]
  )
) {
  await wait(100);
}
const secondPinned = second.gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  inBackground: true,
});
await wait(300);
second.gBrowser.pinTab(secondPinned);
const sourceReadyDeadline = Date.now() + 5000;
while (
  Date.now() < sourceReadyDeadline &&
  !second.gBrowser.tabs.includes(secondPinned)
) {
  await wait(100);
}
check(
  "drag-cross-window-source-ready",
  second.gBrowser.tabs.includes(secondPinned) && secondPinned.pinned === true,
  {
    present: second.gBrowser.tabs.includes(secondPinned),
    pinned: secondPinned.pinned,
  }
);
const beforeCross = [...gBrowser.tabs].length;
await dropTab(secondPinned, normalA);
check(
  "drag-cross-window-blocked",
  second.gBrowser.tabs.includes(secondPinned) &&
    secondPinned.pinned === true &&
    [...gBrowser.tabs].length === beforeCross,
  {
    sourcePresent: second.gBrowser.tabs.includes(secondPinned),
    sourcePinned: secondPinned.pinned,
    targetTabCount: [...gBrowser.tabs].length,
    sourceInFirst: gBrowser.tabs.includes(secondPinned),
    secondTabCount: second.gBrowser.tabs.length,
    sourceWindowMatches: secondPinned.documentGlobal === second,
  }
);
second.close();
await wait(500);

// Duplicate mode is opt-in; the #2 copy path remains available.
api.setDragBehavior("duplicate");
await duplicateScenario("drag-duplicate-essential-to-normal", essentialA, normalA, "normal");
await duplicateScenario("drag-duplicate-pinned-to-normal", pinnedA, normalA, "normal");
await duplicateScenario("drag-duplicate-pinned-to-essential", pinnedB, essentialB, "essential");
await duplicateScenario("drag-duplicate-essential-to-pinned", essentialB, pinnedB, "pinned");

const failureSource = await makeTab({ essential: true });
const beforeFailure = new Set(gBrowser.tabs);
const originalDuplicate = gBrowser.duplicateTab;
gBrowser.duplicateTab = () => {
  throw new Error("synthetic duplication failure");
};
try {
  await dropTab(failureSource, normalA);
} finally {
  gBrowser.duplicateTab = originalDuplicate;
}
const afterFailure = addedSince(beforeFailure);
check(
  "drag-duplication-failure",
  afterFailure.length === 0 && zone(failureSource) === "essential",
  {
    added: afterFailure.length,
    sourceZone: zone(failureSource),
    expectedSourceZone: "essential",
  }
);

const internal = await makeTab({ essential: true, url: "about:config" });
const beforeInternal = new Set(gBrowser.tabs);
await dropTab(internal, normalA);
let afterInternal = addedSince(beforeInternal);
const internalDeadline = Date.now() + 8000;
while (
  Date.now() < internalDeadline &&
  !(
    afterInternal.length <= 1 &&
    zone(internal) === "essential" &&
    (afterInternal.length === 0 || zone(afterInternal[0]) === "normal")
  )
) {
  await wait(50);
  afterInternal = addedSince(beforeInternal);
}
check(
  "drag-internal-page",
  afterInternal.length <= 1 &&
    zone(internal) === "essential" &&
    (afterInternal.length === 0 || zone(afterInternal[0]) === "normal"),
  {
    added: afterInternal.length,
    sourceZone: zone(internal),
    copyZone: afterInternal[0] ? zone(afterInternal[0]) : null,
  }
);

const unknownSource = await makeTab({ essential: true });
const beforeUnknown = new Set(gBrowser.tabs);
await dropTab(unknownSource, gBrowser.tabContainer);
const afterUnknown = addedSince(beforeUnknown);
check(
  "drag-unknown-target-blocked",
  afterUnknown.length === 0 && zone(unknownSource) === "essential",
  {
    added: afterUnknown.length,
    sourceZone: zone(unknownSource),
    expectedSourceZone: "essential",
    blocked: api.snapshot().warnings.some(w =>
      w.includes("drop-blocked:unknown-target")
    ),
  }
);

const cancelSource = await makeTab({ essential: true });
const beforeCancel = new Set(gBrowser.tabs);
dispatchDrop(cancelSource, normalA);
const pendingBeforeUninstall = api.pendingDuplications();
const uninstallReport = api.uninstall();
await wait(600);
const afterCancel = addedSince(beforeCancel);
check(
  "drag-uninstall-cancels-pending",
  pendingBeforeUninstall >= 1 &&
    uninstallReport.status === "uninstalled" &&
    afterCancel.length === 0 &&
    zone(cancelSource) === "essential" &&
    api.pendingDuplications() === 0 &&
    api.hookedWindows() === 0,
  {
    pendingBeforeUninstall,
    status: uninstallReport.status,
    added: afterCancel.length,
    sourceZone: zone(cancelSource),
    pendingAfter: api.pendingDuplications(),
    hookedAfter: api.hookedWindows(),
  }
);

const reinstall = await api.install({ enabled: true, waitForStartup: false });
check(
  "drag-reinstall-after-cancel",
  reinstall.status === "installed" &&
    api.hookedWindows() >= 1 &&
    api.dragBehavior() === "block",
  { status: reinstall.status, hooked: api.hookedWindows(), behavior: api.dragBehavior() }
);

return {
  results,
  hooked: api.hookedWindows(),
  behavior: api.dragBehavior(),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 90_000 }
  );
}

async function runAdvancedDragScenarios(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const api = globalThis.Svalinn;
const gBrowser = win.gBrowser;
const manager = win.gZenPinnedTabManager;
const workspaces = win.gZenWorkspaces;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const zone = tab =>
  tab.hasAttribute("zen-essential")
    ? "essential"
    : tab.pinned
      ? "pinned"
      : "normal";
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const base = ${JSON.stringify(urls.normal)};
let seq = 0;
const results = [];
const check = (name, ok, details) => results.push({ name, ok, details });

const makeTab = async ({ pinned = false, essential = false, url = null, userContextId = 0 } = {}) => {
  const tab = gBrowser.addTab(url ?? base + "#advanced-" + ++seq, {
    triggeringPrincipal: principal,
    inBackground: true,
    userContextId,
  });
  await wait(120);
  if (pinned || essential) gBrowser.pinTab(tab);
  await wait(100);
  if (essential) manager.addToEssentials(tab);
  await wait(150);
  return tab;
};

const dispatchDrop = (
  source,
  target,
  movingTabs = [source],
  extraDragData = {}
) => {
  source._dragData = {
    movingTabs,
    movingTabsSet: new Set(movingTabs),
    fromTabList: false,
    dropElement: target,
    dropBefore: true,
    translateX: (target.screenX ?? 0) - (source.screenX ?? 0),
    translateY: (target.screenY ?? 0) - (source.screenY ?? 0),
    tabWidth: source.getBoundingClientRect().width || 200,
    tabHeight: source.getBoundingClientRect().height || 30,
    ...extraDragData,
  };
  const dataTransfer = new win.DataTransfer();
  dataTransfer.mozSetDataAt(win.TAB_DROP_TYPE, source, 0);
  dataTransfer.dropEffect = "move";
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(new win.DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    screenX: (target.screenX ?? rect.left) + rect.width / 2,
    screenY: (target.screenY ?? rect.top) + rect.height / 2 + 2,
  }));
};

const originalWorkspace = workspaces.activeWorkspace;
const originalData = workspaces.getActiveWorkspaceFromCache();
const workspace = {
  ...originalData,
  uuid: "svalinn-ws-" + Date.now(),
  name: "Svalinn Workspace",
  containerTabId: 1,
};
workspaces.saveWorkspace(workspace);
await wait(500);
await workspaces.changeWorkspaceWithID(workspace.uuid);
await wait(1200);

const containerPinned = await makeTab({ pinned: true, userContextId: 1 });
const containerNormal = await makeTab({ userContextId: 1 });
const containerEssential = await makeTab({ essential: true, userContextId: 1 });
api.setDragBehavior("duplicate");
await dispatchDrop(containerPinned, containerNormal);
await wait(1200);
const containerCopy = [...gBrowser.tabs].find(
  tab =>
    tab !== containerPinned &&
    tab.linkedBrowser?.currentURI?.spec === base + "#advanced-1"
);
check(
  "drag-duplicate-container",
  Boolean(containerCopy) &&
    containerCopy.userContextId === 1 &&
    zone(containerCopy) === "normal" &&
    zone(containerPinned) === "pinned",
  {
    copy: Boolean(containerCopy),
    copyContainer: containerCopy?.userContextId ?? null,
    copyZone: containerCopy ? zone(containerCopy) : null,
    sourceZone: zone(containerPinned),
  }
);

// Move to the original workspace: source tabs from another workspace must block.
await workspaces.changeWorkspaceWithID(originalWorkspace);
await wait(1200);
const localPinned = await makeTab({ pinned: true });
const localNormal = await makeTab();
const localEssential = await makeTab({ essential: true });
await dispatchDrop(containerPinned, localPinned);
check(
  "drag-cross-workspace-blocked",
  zone(containerPinned) === "pinned" &&
    containerPinned.getAttribute("zen-workspace-id") === workspace.uuid &&
    zone(localPinned) === "pinned",
  {
    sourceZone: zone(containerPinned),
    sourceWorkspace: containerPinned.getAttribute("zen-workspace-id"),
    expectedWorkspace: workspace.uuid,
  }
);

await dispatchDrop(containerEssential, localEssential);
check(
  "drag-container-specific-essential-blocked",
  zone(containerEssential) === "essential" &&
    containerEssential.userContextId === 1,
  {
    sourceZone: zone(containerEssential),
    sourceContainer: containerEssential.userContextId,
  }
);

// Folder label expansion: a protected child must be found and protected.
const folderA = await makeTab({ pinned: true });
const folderB = await makeTab({ pinned: true });
const folder = win.gZenFolders.createFolder([folderA, folderB]);
await wait(700);
await dispatchDrop(folder, localPinned);
const groupFolder = folderA.closest("zen-folder");
const groupMembersBefore = (folder.tabs ?? [folderA, folderB]).map(tab => tab.id);
const groupCountBefore = gBrowser.tabs.length;
await dispatchDrop(folder, localNormal);
await wait(800);
check(
  "drag-group-label-cross-category-blocked",
  zone(folderA) === "pinned" && zone(folderB) === "pinned" &&
    folderA.closest("zen-folder") === groupFolder &&
    folderB.closest("zen-folder") === groupFolder &&
    (folder.tabs ?? []).map(tab => tab.id).join(",") === groupMembersBefore.join(",") &&
    gBrowser.tabs.length === groupCountBefore,
  {
    firstZone: zone(folderA),
    secondZone: zone(folderB),
    sameFolderA: folderA.closest("zen-folder") === groupFolder,
    sameFolderB: folderB.closest("zen-folder") === groupFolder,
    sameMembers:
      (folder.tabs ?? []).map(tab => tab.id).join(",") === groupMembersBefore.join(","),
    tabCountDelta: gBrowser.tabs.length - groupCountBefore,
  }
);
const beforeFolderNative = new Set(gBrowser.tabs);
await dispatchDrop(folder, localPinned, [folder]);
check(
  "drag-group-label-same-zone-native",
  [...gBrowser.tabs].length === beforeFolderNative.size &&
    zone(folderA) === "pinned" && zone(folderB) === "pinned",
  {
    added: [...gBrowser.tabs].length - beforeFolderNative.size,
    firstZone: zone(folderA),
  }
);

// Folder-to-folder organization: same category, protected membership preserved.
const folderSecondTab = await makeTab({ pinned: true });
const folderSecond = win.gZenFolders.createFolder([folderSecondTab]);
await wait(700);
const folderTabId = folderA.id;
const folderTabContainer = folderA.userContextId;
const folderTabWorkspace = folderA.getAttribute("zen-workspace-id");
const folderCountBefore = gBrowser.tabs.length;
await dispatchDrop(
  folderA,
  folderSecond.labelElement ?? folderSecond,
  [folderA],
  { shouldDropIntoCollapsedTabGroup: true }
);
await wait(1200);
check(
  "folder-to-folder-membership",
  folderA.pinned === true &&
    zone(folderA) === "pinned" &&
    folderA.closest("zen-folder") === folderSecond &&
    folderA.id === folderTabId &&
    folderA.userContextId === folderTabContainer &&
    folderA.getAttribute("zen-workspace-id") === folderTabWorkspace &&
    gBrowser.tabs.length === folderCountBefore,
  {
    pinned: folderA.pinned,
    zone: zone(folderA),
    inTargetFolder: folderA.closest("zen-folder") === folderSecond,
    sameTab: folderA.id === folderTabId,
    sameContainer: folderA.userContextId === folderTabContainer,
    sameWorkspace: folderA.getAttribute("zen-workspace-id") === folderTabWorkspace,
    tabCountDelta: gBrowser.tabs.length - folderCountBefore,
    targetIsLabel: Boolean(folderSecond.labelElement),
  }
);

// Split-view target must block a protected drop.
const splitA = await makeTab();
const splitB = await makeTab();
win.gZenViewSplitter.splitTabs([splitA, splitB], "grid", 0, { activate: false });
await wait(700);
const splitGroup = splitA.group;
const splitMembers = (splitGroup?.tabs ?? [splitA, splitB]).map(tab => tab.id);
const splitBefore = new Set(gBrowser.tabs);
await dispatchDrop(localPinned, splitA);
check(
  "drag-split-view-blocked",
  [...gBrowser.tabs].length === splitBefore.size &&
    zone(localPinned) === "pinned" &&
    splitA.splitView === true &&
    splitA.group === splitGroup &&
    splitB.group === splitGroup &&
    (splitGroup?.tabs ?? []).map(tab => tab.id).join(",") === splitMembers.join(","),
  {
    added: [...gBrowser.tabs].length - splitBefore.size,
    sourceZone: zone(localPinned),
    split: splitA.splitView,
    sameSplitGroup: splitA.group === splitGroup,
    sameSplitMembers:
      (splitGroup?.tabs ?? []).map(tab => tab.id).join(",") === splitMembers.join(","),
  }
);

// Split-view source containing protected tabs fails closed.
const splitPinnedA = await makeTab({ pinned: true });
const splitPinnedB = await makeTab({ pinned: true });
win.gZenViewSplitter.splitTabs([splitPinnedA, splitPinnedB], "grid", 0, {
  activate: false,
});
await wait(700);
const splitPinnedGroup = splitPinnedA.group;
const splitPinnedMembers = (splitPinnedGroup?.tabs ?? [splitPinnedA, splitPinnedB]).map(
  tab => tab.id
);
await dispatchDrop(splitPinnedA, localPinned);
check(
  "drag-split-view-source-blocked",
  zone(splitPinnedA) === "pinned" &&
    zone(splitPinnedB) === "pinned" &&
    splitPinnedA.splitView === true &&
    splitPinnedA.group === splitPinnedGroup &&
    splitPinnedB.group === splitPinnedGroup &&
    (splitPinnedGroup?.tabs ?? []).map(tab => tab.id).join(",") ===
      splitPinnedMembers.join(","),
  {
    firstZone: zone(splitPinnedA),
    secondZone: zone(splitPinnedB),
    split: splitPinnedA.splitView,
    sameSplitGroup: splitPinnedA.group === splitPinnedGroup,
    sameSplitMembers:
      (splitPinnedGroup?.tabs ?? []).map(tab => tab.id).join(",") ===
      splitPinnedMembers.join(","),
  }
);

// Multi-selected same-category move remains native and changes order.
const multiA = await makeTab({ pinned: true });
const multiB = await makeTab({ pinned: true });
const multiC = await makeTab({ pinned: true });
const multiBefore = new Set(gBrowser.tabs);
gBrowser.selectedTab = multiC;
gBrowser.addToMultiSelectedTabs(multiC);
gBrowser.addToMultiSelectedTabs(multiB);
const selectedMovingTabs = [...gBrowser.selectedTabs];
const orderBefore = [...gBrowser.tabs].map(tab => tab.id);
await dispatchDrop(multiC, multiA, selectedMovingTabs);
await wait(700);
gBrowser.clearMultiSelectedTabs();
const orderAfter = [...gBrowser.tabs].map(tab => tab.id);
check(
  "drag-multi-same-category-native",
  [...gBrowser.tabs].length === multiBefore.size &&
    zone(multiA) === "pinned" &&
    zone(multiB) === "pinned" &&
    selectedMovingTabs.length === 2 &&
    orderBefore.join(",") !== orderAfter.join(","),
  {
    added: [...gBrowser.tabs].length - multiBefore.size,
    firstZone: zone(multiA),
    secondZone: zone(multiB),
    orderChanged: orderBefore.join(",") !== orderAfter.join(","),
    selectionSize: selectedMovingTabs.length,
  }
);

api.setDragBehavior("block");
await workspaces.changeWorkspaceWithID(originalWorkspace);
await wait(800);

return {
  results,
  workspace: workspace.uuid,
  originalWorkspace,
  activeWorkspace: workspaces.activeWorkspace,
  behavior: api.dragBehavior(),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 90_000 }
  );
}

async function runDetachScenarios(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const api = globalThis.Svalinn;
const gBrowser = win.gBrowser;
const manager = win.gZenPinnedTabManager;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const base = ${JSON.stringify(urls.normal)};
let seq = 0;
const results = [];
const check = (name, ok, details) => results.push({ name, ok, details });
const zone = tab =>
  tab.hasAttribute("zen-essential")
    ? "essential"
    : tab.pinned
      ? "pinned"
      : "normal";
const windowCount = () =>
  [...Services.wm.getEnumerator("navigator:browser")].length;

const makeTab = async ({ pinned = false, essential = false } = {}) => {
  const tab = gBrowser.addTab(base + "#detach-" + ++seq, {
    triggeringPrincipal: principal,
    inBackground: true,
  });
  await wait(120);
  if (pinned || essential) gBrowser.pinTab(tab);
  await wait(100);
  if (essential) manager.addToEssentials(tab);
  await wait(150);
  return tab;
};

const dragEnd = async (source, movingTabs = [source]) => {
  const dataTransfer = new win.DataTransfer();
  dataTransfer.mozSetDataAt(win.TAB_DROP_TYPE, source, 0);
  dataTransfer.dropEffect = "none";
  source._dragData = {
    movingTabs,
    movingTabsSet: new Set(movingTabs),
    fromTabList: false,
    offsetX: 10,
    offsetY: 10,
    screenX: win.screenX,
    screenY: win.screenY,
    translateX: 0,
    translateY: 0,
    tabWidth: 200,
    tabHeight: 30,
  };
  const event = {
    dataTransfer,
    screen: win.screen,
    screenX: win.screenX + win.outerWidth + 80,
    screenY: win.screenY + 100,
    stopPropagation() {},
    preventDefault() {},
  };
  const dnd = gBrowser.tabContainer.tabDragAndDrop;
  const before = windowCount();
  dnd.handle_dragend(event);
  await wait(900);
  return { before, after: windowCount() };
};

const pinned = await makeTab({ pinned: true });
const essential = await makeTab({ essential: true });
const normal = await makeTab();

const pinnedDetach = await dragEnd(pinned);
check(
  "detach-pinned-blocked",
  pinnedDetach.before === pinnedDetach.after &&
    gBrowser.tabs.includes(pinned) &&
    zone(pinned) === "pinned",
  { ...pinnedDetach, present: gBrowser.tabs.includes(pinned), zone: zone(pinned) }
);

const essentialDetach = await dragEnd(essential);
check(
  "detach-essential-blocked",
  essentialDetach.before === essentialDetach.after &&
    gBrowser.tabs.includes(essential) &&
    zone(essential) === "essential",
  { ...essentialDetach, present: gBrowser.tabs.includes(essential), zone: zone(essential) }
);

const folderA = await makeTab({ pinned: true });
const folderB = await makeTab({ pinned: true });
const folder = win.gZenFolders.createFolder([folderA, folderB]);
await wait(700);
const folderMembers = (folder.tabs ?? []).map(tab => tab.id);
const folderDetach = await dragEnd(folder, [folder]);
check(
  "detach-group-blocked",
  folderDetach.before === folderDetach.after &&
    (folder.tabs ?? []).map(tab => tab.id).join(",") === folderMembers.join(",") &&
    zone(folderA) === "pinned" && zone(folderB) === "pinned",
  {
    ...folderDetach,
    sameMembers:
      (folder.tabs ?? []).map(tab => tab.id).join(",") === folderMembers.join(","),
    firstZone: zone(folderA),
    secondZone: zone(folderB),
  }
);

const multiNormal = await makeTab();
gBrowser.selectedTab = pinned;
gBrowser.addToMultiSelectedTabs(pinned);
gBrowser.addToMultiSelectedTabs(multiNormal);
const multiMembers = [pinned, multiNormal];
const multiDetach = await dragEnd(pinned, multiMembers);
gBrowser.clearMultiSelectedTabs();
check(
  "detach-multi-blocked",
  multiDetach.before === multiDetach.after &&
    gBrowser.tabs.includes(pinned) &&
    gBrowser.tabs.includes(multiNormal) &&
    zone(pinned) === "pinned" &&
    zone(multiNormal) === "normal",
  {
    ...multiDetach,
    pinnedPresent: gBrowser.tabs.includes(pinned),
    normalPresent: gBrowser.tabs.includes(multiNormal),
  }
);

const detachedNormal = await makeTab();
const beforeNormal = windowCount();
const newWindow = gBrowser.replaceTabsWithWindow(detachedNormal);
await wait(1200);
check(
  "detach-normal-native",
  Boolean(newWindow) && windowCount() === beforeNormal + 1,
  {
    returned: Boolean(newWindow),
    before: beforeNormal,
    after: windowCount(),
  }
);
try {
  newWindow?.close();
} catch {}
await wait(800);

return {
  results,
  windows: windowCount(),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 90_000 }
  );
}

async function runCloseProtectionScenarios(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const api = globalThis.Svalinn;
const gBrowser = win.gBrowser;
const manager = win.gZenPinnedTabManager;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const zone = tab =>
  tab.hasAttribute("zen-essential")
    ? "essential"
    : tab.pinned
      ? "pinned"
      : "normal";
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const base = ${JSON.stringify(urls.normal)};
let seq = 0;
const tabsInclude = tab => [...gBrowser.tabs].includes(tab);

const makeTab = async ({ pinned = false, essential = false } = {}) => {
  const tab = gBrowser.addTab(base + "#close-" + ++seq, {
    triggeringPrincipal: principal,
    inBackground: true,
  });
  await wait(80);
  if (pinned || essential) gBrowser.pinTab(tab);
  await wait(60);
  if (essential) manager.addToEssentials(tab);
  await wait(120);
  return tab;
};

const results = [];
const check = (name, ok, details) => results.push({ name, ok, details });

const pinned = await makeTab({ pinned: true });
const essential = await makeTab({ essential: true });
const normal = await makeTab();
const normalMulti = await makeTab();

gBrowser.removeTab(pinned);
gBrowser.removeTab(essential);
check(
  "close-protected-blocked",
  tabsInclude(pinned) && tabsInclude(essential),
  { pinned: tabsInclude(pinned), essential: tabsInclude(essential), pinnedZone: zone(pinned), essentialZone: zone(essential) }
);

gBrowser.selectedTab = essential;
gBrowser.removeCurrentTab();
check(
  "close-current-protected-blocked",
  tabsInclude(essential) && zone(essential) === "essential",
  { present: tabsInclude(essential), zone: zone(essential) }
);

gBrowser.removeTab(normal);
check(
  "close-normal-allowed",
  !tabsInclude(normal),
  { present: tabsInclude(normal) }
);

gBrowser.removeTabs([pinned, normalMulti]);
const multiCloseDeadline = Date.now() + 5000;
while (Date.now() < multiCloseDeadline && tabsInclude(normalMulti)) {
  await wait(100);
}
check(
  "multi-close-keeps-protected",
  tabsInclude(pinned) && !tabsInclude(normalMulti),
  { pinned: tabsInclude(pinned), normal: tabsInclude(normalMulti) }
);

gBrowser.unpinTab(pinned);
manager.removeEssentials(essential);
check(
  "demotion-blocked",
  pinned.pinned === true && essential.hasAttribute("zen-essential"),
  {
    pinnedPinned: pinned.pinned,
    essentialEssential: essential.hasAttribute("zen-essential"),
    pinnedZone: zone(pinned),
    essentialZone: zone(essential),
  }
);

const shortcutEvent = { stopPropagation() {}, preventDefault() {} };
await manager.onCloseTabShortcut(shortcutEvent, pinned, { behavior: "close" });
check(
  "zen-close-shortcut-blocked",
  tabsInclude(pinned) && zone(pinned) === "pinned",
  { present: tabsInclude(pinned), zone: zone(pinned) }
);

const unloaded = await gBrowser.explicitUnloadTabs([pinned]);
check(
  "unload-protected-allowed",
  unloaded === true && tabsInclude(pinned),
  { unloaded, present: tabsInclude(pinned), pending: pinned.hasAttribute("pending") }
);

const normalCurrent = await makeTab();
gBrowser.selectedTab = normalCurrent;
gBrowser.removeCurrentTab();
check(
  "close-current-normal-allowed",
  !tabsInclude(normalCurrent),
  { present: tabsInclude(normalCurrent) }
);

return {
  results,
  closeGuarded: api.closeGuardedWindows(),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 60_000 }
  );
}

async function runCssMenuScenarios(client, urls) {
  return runScript(
    client,
    `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const api = globalThis.Svalinn;
const gBrowser = win.gBrowser;
const manager = win.gZenPinnedTabManager;
const doc = win.document;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeDisplay = tab => {
  const button = tab.querySelector(".tab-close-button");
  return button ? win.getComputedStyle(button).display : null;
};
const tabsInclude = tab => [...gBrowser.tabs].includes(tab);
const zone = tab =>
  tab.hasAttribute("zen-essential")
    ? "essential"
    : tab.pinned
      ? "pinned"
      : "normal";
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const base = ${JSON.stringify(urls.normal)};
let seq = 0;
const makeTab = async ({ pinned = false, essential = false } = {}) => {
  const tab = gBrowser.addTab(base + "#css-" + ++seq, {
    triggeringPrincipal: principal,
    inBackground: true,
  });
  await wait(80);
  if (pinned || essential) gBrowser.pinTab(tab);
  await wait(60);
  if (essential) manager.addToEssentials(tab);
  await wait(120);
  return tab;
};
const results = [];
const check = (name, ok, details) => results.push({ name, ok, details });
const blocked = id =>
  doc.getElementById(id)?.getAttribute("svalinn-blocked") === "true";
const hidden = id => Boolean(doc.getElementById(id)?.hidden);

const pinned = await makeTab({ pinned: true });
const essential = await makeTab({ essential: true });
const normal = await makeTab();

check(
  "css-close-buttons",
  closeDisplay(pinned) === "none" &&
    closeDisplay(essential) === "none" &&
    closeDisplay(normal) !== "none" &&
    doc.documentElement.hasAttribute("svalinn-active"),
  {
    pinned: closeDisplay(pinned),
    essential: closeDisplay(essential),
    normal: closeDisplay(normal),
    activeMarker: doc.documentElement.hasAttribute("svalinn-active"),
  }
);

const folderTab = await makeTab({ pinned: true });
const folder = win.gZenFolders.createFolder([folderTab]);
await wait(400);
check(
  "css-folder-tab",
  Boolean(folderTab.closest("zen-folder")) &&
    closeDisplay(folderTab) === "none",
  {
    inFolder: Boolean(folderTab.closest("zen-folder")),
    closeDisplay: closeDisplay(folderTab),
  }
);

const menu = doc.getElementById("tabContextMenu");
const nativeMenuState = tab => {
  gBrowser.selectedTab = tab;
  win.TabContextMenu.contextTab = tab;
  win.TabContextMenu.updateContextMenu(menu);
  return {
    closeHidden: hidden("context_closeTab"),
    unpinHidden: hidden("context_unpinTab"),
    removeHidden: hidden("context_zen-remove-essential"),
  };
};
const showMenuFor = async tab => {
  nativeMenuState(tab);
  menu.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
  await wait(50);
};

const pinnedNative = nativeMenuState(pinned);
await showMenuFor(pinned);
check(
  "context-menu-locked-pinned",
  blocked("context_closeTab") &&
    blocked("context_unpinTab") &&
    hidden("context_closeTab") === pinnedNative.closeHidden &&
    hidden("context_unpinTab") === pinnedNative.unpinHidden,
  {
    closeBlocked: blocked("context_closeTab"),
    unpinBlocked: blocked("context_unpinTab"),
    closeHidden: hidden("context_closeTab"),
    unpinHidden: hidden("context_unpinTab"),
    native: pinnedNative,
  }
);

const essentialNative = nativeMenuState(essential);
await showMenuFor(essential);
check(
  "context-menu-locked-essential",
  blocked("context_closeTab") &&
    blocked("context_zen-remove-essential") &&
    hidden("context_closeTab") === essentialNative.closeHidden &&
    hidden("context_zen-remove-essential") === essentialNative.removeHidden,
  {
    closeBlocked: blocked("context_closeTab"),
    removeBlocked: blocked("context_zen-remove-essential"),
    closeHidden: hidden("context_closeTab"),
    removeHidden: hidden("context_zen-remove-essential"),
    native: essentialNative,
  }
);

const normalNative = nativeMenuState(normal);
await showMenuFor(normal);
check(
  "context-menu-normal-native",
  !blocked("context_closeTab") &&
    !blocked("context_unpinTab") &&
    !blocked("context_zen-remove-essential") &&
    hidden("context_closeTab") === normalNative.closeHidden &&
    hidden("context_unpinTab") === normalNative.unpinHidden &&
    hidden("context_zen-remove-essential") === normalNative.removeHidden,
  {
    closeHidden: hidden("context_closeTab"),
    unpinHidden: hidden("context_unpinTab"),
    removeHidden: hidden("context_zen-remove-essential"),
    native: normalNative,
  }
);

await showMenuFor(pinned);
await showMenuFor(normal);
check(
  "context-menu-reopen-native",
  !blocked("context_closeTab") &&
    hidden("context_closeTab") === normalNative.closeHidden &&
    hidden("context_unpinTab") === normalNative.unpinHidden &&
    hidden("context_zen-remove-essential") === normalNative.removeHidden,
  {
    closeBlocked: blocked("context_closeTab"),
    closeHidden: hidden("context_closeTab"),
    unpinHidden: hidden("context_unpinTab"),
    removeHidden: hidden("context_zen-remove-essential"),
  }
);

check(
  "context-menu-style-present",
  Boolean(doc.getElementById("svalinn-menu-style")),
  { style: Boolean(doc.getElementById("svalinn-menu-style")) }
);

const unpinItem = doc.getElementById("context_svalinn-unpin");
const removeItem = doc.getElementById("context_svalinn-remove-essential");
const intentPinned = await makeTab({ pinned: true });
const intentEssential = await makeTab({ essential: true });
const intentOther = await makeTab({ pinned: true });
const intentNormal = await makeTab();

await showMenuFor(intentPinned);
check(
  "intent-menu-pinned",
  unpinItem.hidden === false &&
    removeItem.hidden === true &&
    blocked("context_unpinTab"),
  {
    unpinVisible: !unpinItem.hidden,
    removeVisible: !removeItem.hidden,
    nativeUnpinBlocked: blocked("context_unpinTab"),
  }
);
unpinItem.dispatchEvent(new win.Event("command", { bubbles: true }));
await wait(350);
check(
  "intent-unpin-action",
  intentPinned.pinned === false && zone(intentPinned) === "normal",
  { pinned: intentPinned.pinned, zone: zone(intentPinned) }
);

check(
  "intent-essential-ready",
  intentEssential.hasAttribute("zen-essential") &&
    intentEssential.pinned === true,
  {
    essential: intentEssential.hasAttribute("zen-essential"),
    pinned: intentEssential.pinned,
    activeWorkspace: win.gZenWorkspaces.activeWorkspace,
    tabWorkspace: intentEssential.getAttribute("zen-workspace-id"),
  }
);
await wait(250);
await showMenuFor(intentEssential);
check(
  "intent-menu-essential",
  removeItem.hidden === false &&
    unpinItem.hidden === true &&
    blocked("context_zen-remove-essential"),
  {
    removeVisible: !removeItem.hidden,
    unpinVisible: !unpinItem.hidden,
    nativeRemoveBlocked: blocked("context_zen-remove-essential"),
  }
);
removeItem.dispatchEvent(new win.Event("command", { bubbles: true }));
await wait(350);
check(
  "intent-remove-essential-action",
  intentEssential.hasAttribute("zen-essential") === false &&
    intentEssential.pinned === false &&
    zone(intentEssential) === "normal",
  {
    essential: intentEssential.hasAttribute("zen-essential"),
    pinned: intentEssential.pinned,
    zone: zone(intentEssential),
  }
);

gBrowser.removeTab(intentOther);
gBrowser.unpinTab(intentOther);
check(
  "intent-authorization-cleared",
  tabsInclude(intentOther) &&
    intentOther.pinned === true &&
    intentOther.hasAttribute("zen-essential") === false,
  {
    present: tabsInclude(intentOther),
    pinned: intentOther.pinned,
    zone: zone(intentOther),
  }
);

gBrowser.selectedTab = intentOther;
gBrowser.addToMultiSelectedTabs(intentOther);
gBrowser.addToMultiSelectedTabs(intentNormal);
win.TabContextMenu.contextTab = intentOther;
win.TabContextMenu.updateContextMenu(menu);
menu.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
await wait(50);
check(
  "intent-menu-multiselected",
  unpinItem.hidden === true &&
    removeItem.hidden === true &&
    blocked("context_unpinSelectedTabs"),
  {
    unpinVisible: !unpinItem.hidden,
    removeVisible: !removeItem.hidden,
    nativeUnpinSelectedBlocked: blocked("context_unpinSelectedTabs"),
  }
);
gBrowser.clearMultiSelectedTabs();

await showMenuFor(folderTab);
check(
  "intent-menu-folder",
  unpinItem.hidden === false && removeItem.hidden === true,
  {
    unpinVisible: !unpinItem.hidden,
    removeVisible: !removeItem.hidden,
  }
);
unpinItem.dispatchEvent(new win.Event("command", { bubbles: true }));
await wait(350);
check(
  "intent-folder-unpin",
  folderTab.pinned === false && zone(folderTab) === "normal",
  { pinned: folderTab.pinned, zone: zone(folderTab) }
);

// One global Locked / Unlocked checkbox.
const lockItem = doc.getElementById("context_svalinn-protect");
const lockSeparator = doc.getElementById("context_svalinn-protect-separator");
const toggleLockedTab = await makeTab({ pinned: true });
const toggleNormalTab = await makeTab();

await showMenuFor(toggleLockedTab);
check(
  "lock-menu-visible-locked",
  Boolean(lockItem) &&
    Boolean(lockSeparator) &&
    lockItem.hidden === false &&
    lockSeparator.hidden === false &&
    lockItem.checked === true &&
    lockItem.getAttribute("checked") === "true" &&
    /Protect Pinned & Essentials/.test(lockItem.getAttribute("label")) &&
    closeDisplay(toggleLockedTab) === "none",
  {
    present: Boolean(lockItem),
    hidden: lockItem?.hidden,
    checked: lockItem?.checked,
    label: lockItem?.getAttribute("label"),
    closeDisplay: closeDisplay(toggleLockedTab),
  }
);

await showMenuFor(toggleNormalTab);
check(
  "lock-menu-hidden-on-normal-tab",
  lockItem.hidden === true && lockSeparator.hidden === true,
  { hidden: lockItem.hidden, separatorHidden: lockSeparator.hidden }
);

await showMenuFor(toggleLockedTab);
lockItem.dispatchEvent(new win.Event("command", { bubbles: true }));
await wait(150);
check(
  "unlocked-global-state",
  api.snapshot().locked === false &&
    Services.prefs.getBoolPref("svalinn.locked", true) === false &&
    doc.documentElement.hasAttribute("svalinn-unlocked"),
  {
    locked: api.snapshot().locked,
    pref: Services.prefs.getBoolPref("svalinn.locked", true),
    marker: doc.documentElement.hasAttribute("svalinn-unlocked"),
  }
);

await showMenuFor(toggleLockedTab);
check(
  "unlocked-menu-indication",
  lockItem.checked === false &&
    lockItem.getAttribute("checked") === "false" &&
    /unlocked/i.test(lockItem.getAttribute("label")) &&
    unpinItem.hidden === true &&
    removeItem.hidden === true &&
    !blocked("context_closeTab") &&
    !blocked("context_unpinTab") &&
    !blocked("context_zen-remove-essential"),
  {
    checked: lockItem.checked,
    label: lockItem.getAttribute("label"),
    unpinVisible: !unpinItem.hidden,
    removeVisible: !removeItem.hidden,
    closeBlocked: blocked("context_closeTab"),
    unpinBlocked: blocked("context_unpinTab"),
  }
);

check(
  "unlocked-close-controls-native",
  doc.documentElement.hasAttribute("svalinn-unlocked") &&
    !blocked("context_closeTab"),
  {
    unlocked: doc.documentElement.hasAttribute("svalinn-unlocked"),
    closeDisplay: closeDisplay(toggleLockedTab),
    closeBlocked: blocked("context_closeTab"),
  }
);

gBrowser.removeTab(toggleLockedTab);
check(
  "unlocked-native-close",
  !tabsInclude(toggleLockedTab),
  { present: tabsInclude(toggleLockedTab) }
);

const unlockNativeUnpin = await makeTab({ pinned: true });
gBrowser.unpinTab(unlockNativeUnpin);
check(
  "unlocked-native-unpin",
  unlockNativeUnpin.pinned === false && zone(unlockNativeUnpin) === "normal",
  { pinned: unlockNativeUnpin.pinned, zone: zone(unlockNativeUnpin) }
);

const relockTab = await makeTab({ pinned: true });
await showMenuFor(relockTab);
lockItem.dispatchEvent(new win.Event("command", { bubbles: true }));
await wait(150);
check(
  "relocked-global-state",
  api.snapshot().locked === true &&
    Services.prefs.getBoolPref("svalinn.locked", true) === true &&
    !doc.documentElement.hasAttribute("svalinn-unlocked") &&
    lockItem.checked === true &&
    closeDisplay(relockTab) === "none",
  {
    locked: api.snapshot().locked,
    pref: Services.prefs.getBoolPref("svalinn.locked", true),
    marker: doc.documentElement.hasAttribute("svalinn-unlocked"),
    checked: lockItem.checked,
    closeDisplay: closeDisplay(relockTab),
  }
);

gBrowser.removeTab(relockTab);
check(
  "relocked-close-blocked",
  tabsInclude(relockTab) && blocked("context_closeTab"),
  { present: tabsInclude(relockTab), closeBlocked: blocked("context_closeTab") }
);

return {
  results,
  activeMarker: doc.documentElement.hasAttribute("svalinn-active"),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 60_000 }
  );
}

function zoneMap(snapshot, urls) {
  const byUrl = new Map();
  for (const win of snapshot?.windows ?? []) {
    for (const tab of win.tabs ?? []) {
      if (tab.url) byUrl.set(tab.url, tab.zone);
    }
  }
  const result = {};
  for (const [zone, url] of Object.entries(urls)) result[zone] = byUrl.get(url) ?? null;
  return result;
}

function fingerprint(snapshot) {
  return JSON.stringify(
    (snapshot?.windows ?? []).map(win =>
      (win.tabs ?? []).map(tab => [tab.id, tab.url, tab.zone])
    )
  );
}

function expectZoneMap(actual, urls) {
  const problems = [];
  for (const zone of Object.keys(urls)) {
    if (actual[zone] !== zone) {
      problems.push(`expected ${zone} tab to map to ${zone}, got ${actual[zone]}`);
    }
  }
  return problems;
}

/**
 * Run the full smoke flow.
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {Promise<object>}
 */
export async function runSmoke(options) {
  const start = Date.now();
  const checks = [];
  const warnings = [];
  const log = message => {
    if (!options.json) console.log(message);
  };

  const record = (name, ok, details) => {
    checks.push({ name, ok, ...(details === undefined ? {} : { details }) });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(details)}`}`);
    if (!ok) throw new SmokeError(`Smoke check failed: ${name}`, details);
    return details;
  };

  let profileInfo = null;
  let processHandle = null;
  let client = null;
  let verified = false;
  let phase = "setup";
  const report = { ok: false, phase, zen: null, profile: null, checks, warnings };

  try {
    profileInfo = await prepareProfile({
      profile: options.profile,
      port: options.port,
    });
    report.profile = profileInfo.profile;
    log(`Profile: ${profileInfo.profile}`);
    report.profileCreated = profileInfo.created;

    if (options.installed) {
      const root = options.installRoot
        ? options.installRoot
        : (await detectInstallRoot()).root;
      await assertDisposableInstallRoot(root);
      const installedFiles = await installPersistent({
        profile: profileInfo.profile,
        installRoot: root,
      });
      report.install = installedFiles;
      log(
        `Installed persistent loader in ${installedFiles.installRoot} ` +
          `(Zen ${installedFiles.zenVersion})`
      );

      if (!options.skipPreflight) {
        const preflight = await preflightInstalledStartup(
          options,
          profileInfo.profile
        );
        record(
          "installed-startup-without-marionette",
          preflight.exited === true &&
            preflight.status === "installed" &&
            preflight.loaderVersion === "0.1.0" &&
            preflight.windows >= 1,
          preflight
        );
      }
    }

    const launch = async () => {
      processHandle = new ZenProcess(
        options.zen,
        zenArgs({ ...options, profile: profileInfo.profile }),
        options
      ).start();
      client = await MarionetteClient.connect({
        port: options.port,
        retryTimeoutMs: options.timeoutMs,
      });
      const session = await connectAndVerify({
        client,
        profile: profileInfo.profile,
        port: options.port,
        child: processHandle.child,
      });
      verified = true;
      report.zen = {
        binary: options.zen,
        version: session.version,
        profile: session.profile,
        pidMatches: session.pidMatches,
        headless: options.headless,
      };
      if (!session.pidMatches) warnings.push("Marionette moz:processID differs from the spawned process");
      return session;
    };

    const shutdown = async () => {
      if (client) {
        if (verified) {
          await client.quit().catch(error => warnings.push(`quit: ${error}`));
        }
        client.close();
        client = null;
        verified = false;
      }
      await processHandle?.waitForExit(20_000).catch(async error => {
        warnings.push(`process-exit: ${error}`);
        await processHandle.stop();
      });
    };

    phase = "startup";
    log(`Launching ${options.zen}...`);
    await launch();
    const ready = await waitForZenReady(client, options.timeoutMs);
    record("startup", ready.app === "Zen" && ready.ready, ready);

    phase = "css-preinstall";
    const preCss = await runScript(
      client,
      `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const gBrowser = win.gBrowser;
const tab = gBrowser.addTab(${JSON.stringify(profileInfo.urls.normal + "#pre-css")}, {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  inBackground: true,
});
await new Promise(resolve => setTimeout(resolve, 150));
gBrowser.pinTab(tab);
await new Promise(resolve => setTimeout(resolve, 200));
const button = tab.querySelector(".tab-close-button");
const display = button ? win.getComputedStyle(button).display : null;
const activeMarker = win.document.documentElement.hasAttribute("svalinn-active");
gBrowser.removeTab(tab);
return { display, activeMarker };
`,
      { timeoutMs: 20_000 }
    );
    record(
      options.installed ? "css-active-from-loader" : "css-inactive-before-install",
      options.installed
        ? preCss.activeMarker === true
        : preCss.activeMarker === false,
      preCss
    );

    phase = "injection";
    const injected = await ensureAdapter(client, 30_000, {
      installed: options.installed,
    });
    record(
      "adapter-injected",
      injected.adapter === "0.6.0" &&
        injected.policy.length >= 4 &&
        (!options.installed || injected.installed === true),
      injected
    );

    const probe = await runAdapter(
      client,
      `return api.probe({ allowUnverifiedVersion: false });`
    );
    record("capabilities", probe.ok === true && probe.isZen === true, probe);

    phase = "install";
    const installed = options.installed
      ? { status: "installed", changedTabs: false }
      : await runAdapter(
          client,
          `return await api.install({ enabled: true, waitForStartup: true, timeoutMs: 30000 });`
        );
    record(
      "adapter-installed",
      installed.status === "installed" && installed.changedTabs === false,
      installed
    );

    const hookState = await runAdapter(
      client,
      `return {
        count: api.hookedWindows(),
        windows: api.snapshot().windows.map(window => window.hooked),
      };`
    );
    record(
      "drop-hook-installed",
      hookState.count >= 1 && hookState.windows.every(Boolean),
      hookState
    );

    const closeHookState = await runAdapter(
      client,
      `return {
        count: api.closeGuardedWindows(),
        windows: api.snapshot().windows.map(window => window.closeHooked),
      };`
    );
    record(
      "close-guard-installed",
      closeHookState.count >= 1 && closeHookState.windows.every(Boolean),
      closeHookState
    );

    phase = "tabs";
    const created = await createSmokeTabs(client, profileInfo.urls);
    const snapshot = await runAdapter(client, `return api.snapshot();`);
    const zones = zoneMap(snapshot, profileInfo.urls);
    const zoneProblems = expectZoneMap(zones, profileInfo.urls);
    record("tab-zones", zoneProblems.length === 0, { zones, problems: zoneProblems, created: created.tabs });

    phase = "drag-drop";
    const drops = await runDropScenarios(client, profileInfo.urls);
    for (const result of drops.results) {
      record(result.name, result.ok, result.details);
    }
    record("drag-drop-hooks-intact", drops.hooked >= 1, { hooked: drops.hooked });

    phase = "drag-contexts";
    const advancedDrops = await runAdvancedDragScenarios(
      client,
      profileInfo.urls
    );
    for (const result of advancedDrops.results) {
      record(result.name, result.ok, result.details);
    }
    record(
      "drag-context-workspace-restored",
      advancedDrops.activeWorkspace === advancedDrops.originalWorkspace &&
        advancedDrops.behavior === "block",
      {
        activeWorkspace: advancedDrops.activeWorkspace,
        originalWorkspace: advancedDrops.originalWorkspace,
        behavior: advancedDrops.behavior,
      }
    );

    phase = "close-protection";
    const closeChecks = await runCloseProtectionScenarios(
      client,
      profileInfo.urls
    );
    for (const result of closeChecks.results) {
      record(result.name, result.ok, result.details);
    }
    record(
      "close-guard-intact",
      closeChecks.closeGuarded >= 1,
      { closeGuarded: closeChecks.closeGuarded }
    );

    phase = "css-menu";
    const cssMenuChecks = await runCssMenuScenarios(
      client,
      profileInfo.urls
    );
    for (const result of cssMenuChecks.results) {
      record(result.name, result.ok, result.details);
    }
    record(
      "active-marker-installed",
      cssMenuChecks.activeMarker === true,
      { activeMarker: cssMenuChecks.activeMarker }
    );

    phase = "drag-detach";
    const detachChecks = await runDetachScenarios(client, profileInfo.urls);
    for (const result of detachChecks.results) {
      record(result.name, result.ok, result.details);
    }
    record(
      "drag-detach-windows-clean",
      detachChecks.windows === 1,
      { windows: detachChecks.windows }
    );

    const afterDropSnapshot = await runAdapter(client, `return api.snapshot();`);
    const afterDropZones = zoneMap(afterDropSnapshot, profileInfo.urls);
    record(
      "tab-zones-after-guards",
      expectZoneMap(afterDropZones, profileInfo.urls).length === 0,
      { zones: afterDropZones }
    );

    const before = fingerprint(afterDropSnapshot);
    const reinstalled = await runAdapter(client, `return await api.install({ enabled: true });`);
    const afterReinstall = fingerprint(await runAdapter(client, `return api.snapshot();`));
    record(
      "install-idempotent",
      reinstalled.status === "already-installed" && afterReinstall === before,
      { status: reinstalled.status, tabsChanged: afterReinstall !== before }
    );

    phase = "uninstall";
    const uninstalled = await runAdapter(client, `return api.uninstall();`);
    const afterUninstall = fingerprint(await runAdapter(client, `return api.snapshot();`));
    const markerState = await runScript(
      client,
      `const win = [...Services.wm.getEnumerator("navigator:browser")][0];
       return {
         attached: Boolean(win.__svalinn),
         installed: globalThis.Svalinn.snapshot().installed,
         hooked: globalThis.Svalinn.hookedWindows(),
         closeHooked: globalThis.Svalinn.closeGuardedWindows(),
       };`
    );
    record(
      "uninstall-clean",
      uninstalled.status === "uninstalled" &&
        afterUninstall === before &&
        markerState.attached === false &&
        markerState.installed === false &&
        markerState.hooked === 0 &&
        markerState.closeHooked === 0,
      { status: uninstalled.status, tabsChanged: afterUninstall !== before, markerState }
    );

    phase = "css-uninstall";
    const postCss = await runScript(
      client,
      `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const tab = win.gBrowser.addTab(${JSON.stringify(profileInfo.urls.normal + "#post-css")}, {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  inBackground: true,
});
await new Promise(resolve => setTimeout(resolve, 150));
win.gBrowser.pinTab(tab);
await new Promise(resolve => setTimeout(resolve, 200));
const button = tab.querySelector(".tab-close-button");
const display = button ? win.getComputedStyle(button).display : null;
const activeMarker = win.document.documentElement.hasAttribute("svalinn-active");
const menuStyle = Boolean(win.document.getElementById("svalinn-menu-style"));
win.gBrowser.removeTab(tab);
return { display, activeMarker, menuStyle };
`,
      { timeoutMs: 20_000 }
    );
    record(
      "css-restored-after-uninstall",
      postCss.activeMarker === false && postCss.menuStyle === false,
      postCss
    );

    phase = "disabled";
    const disabled = await runAdapter(client, `return await api.install({ enabled: false });`);
    const disabledMarker = await runScript(
      client,
      `const win = [...Services.wm.getEnumerator("navigator:browser")][0];
       return {
         attached: Boolean(win.__svalinn),
         installed: globalThis.Svalinn.snapshot().installed,
         hooked: globalThis.Svalinn.hookedWindows(),
         closeHooked: globalThis.Svalinn.closeGuardedWindows(),
       };`
    );
    record(
      "disabled-mode",
      disabled.status === "disabled" &&
        disabled.installed === false &&
        disabledMarker.attached === false &&
        disabledMarker.hooked === 0 &&
        disabledMarker.closeHooked === 0,
      { status: disabled.status, marker: disabledMarker }
    );

    phase = "multi-window";
    const enabledForWindows = await runAdapter(
      client,
      `return await api.install({ enabled: true });`
    );
    const beforeMultiWindow = fingerprint(
      await runAdapter(client, `return api.snapshot();`)
    );
    const multi = await runScript(
      client,
      `
const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const second = win.OpenBrowserWindow();
await new Promise(resolve => second.addEventListener("load", resolve, { once: true }));
const deadline = Date.now() + 5000;
while (
  Date.now() < deadline &&
  !(
    second.__svalinn &&
    second.gBrowser?.["__svalinnCloseHook"] &&
    second.gBrowser?.tabContainer?.tabDragAndDrop?.["__svalinnDropHook"]
  )
) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
const attached = Boolean(second.__svalinn);
const sameInstance = second.__svalinn === globalThis.Svalinn;
const firstAttached = Boolean(win.__svalinn);
const secondCloseHooked = Boolean(second.gBrowser.__svalinnCloseHook);
const secondActiveMarker = second.document.documentElement.hasAttribute(
  "svalinn-active"
);
const secondMenuStyle = Boolean(
  second.document.getElementById("svalinn-menu-style")
);
const secondTab = second.gBrowser.selectedTab;
if (secondTab) second.gBrowser.pinTab(secondTab);
await new Promise(resolve => setTimeout(resolve, 200));
const secondMenu = second.document.getElementById("tabContextMenu");
second.TabContextMenu.contextTab = secondTab;
second.TabContextMenu.contextTabs = secondTab ? [secondTab] : [];
second.TabContextMenu.multiselected = false;
second.TabContextMenu.updateContextMenu(secondMenu);
secondMenu.dispatchEvent(new second.Event("popupshowing", { bubbles: true }));
const secondLock = second.document.getElementById("context_svalinn-protect");
const secondCheckedLocked = Boolean(secondLock?.checked);
const secondUnlockedBefore =
  second.document.documentElement.hasAttribute("svalinn-unlocked");

globalThis.Svalinn.setLocked(false);
const firstUnlocked = win.document.documentElement.hasAttribute(
  "svalinn-unlocked"
);
const secondUnlocked = second.document.documentElement.hasAttribute(
  "svalinn-unlocked"
);
second.TabContextMenu.updateContextMenu(secondMenu);
const secondCheckedUnlocked = Boolean(secondLock?.checked);

const third = win.OpenBrowserWindow();
await new Promise(resolve =>
  third.addEventListener("load", resolve, { once: true })
);
const thirdDeadline = Date.now() + 5000;
while (Date.now() < thirdDeadline && !third.__svalinn) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
const thirdAttached = Boolean(third.__svalinn);
const thirdUnlocked = third.document.documentElement.hasAttribute(
  "svalinn-unlocked"
);

globalThis.Svalinn.setLocked(true);
const relocked =
  !win.document.documentElement.hasAttribute("svalinn-unlocked") &&
  !second.document.documentElement.hasAttribute("svalinn-unlocked") &&
  !third.document.documentElement.hasAttribute("svalinn-unlocked");
second.TabContextMenu.updateContextMenu(secondMenu);
const secondCheckedRelocked = Boolean(secondLock?.checked);

third.close();
const closeGuarded = globalThis.Svalinn.closeGuardedWindows();
const snapshot = globalThis.Svalinn.snapshot();
const windows = snapshot.windows.length;
const windowsWithManager = snapshot.windows.filter(window => window.hasManager).length;
second.close();
await new Promise(resolve => setTimeout(resolve, 500));
return {
  attached,
  sameInstance,
  firstAttached,
  secondCloseHooked,
  secondActiveMarker,
  secondMenuStyle,
  secondCheckedLocked,
  secondUnlockedBefore,
  firstUnlocked,
  secondUnlocked,
  secondCheckedUnlocked,
  thirdAttached,
  thirdUnlocked,
  relocked,
  secondCheckedRelocked,
  lockSynced:
    secondCheckedLocked === true &&
    secondUnlockedBefore === false &&
    firstUnlocked === true &&
    secondUnlocked === true &&
    secondCheckedUnlocked === false &&
    thirdAttached === true &&
    thirdUnlocked === true &&
    relocked === true &&
    secondCheckedRelocked === true,
  closeGuarded,
  windows,
  windowsWithManager,
  remaining: [...Services.wm.getEnumerator("navigator:browser")].length,
};`,
      { timeoutMs: 20_000 }
    );
    const afterMultiWindow = fingerprint(
      await runAdapter(client, `return api.snapshot();`)
    );
    record(
      "multi-window-observer",
      enabledForWindows.status === "installed" &&
        multi.attached === true &&
        multi.sameInstance === true &&
        multi.firstAttached === true &&
        multi.secondCloseHooked === true &&
        multi.secondActiveMarker === true &&
        multi.secondMenuStyle === true &&
        multi.lockSynced === true &&
        multi.closeGuarded >= 2 &&
        multi.windows >= 2 &&
        multi.windowsWithManager >= 2 &&
        multi.remaining >= 1 &&
        afterMultiWindow === beforeMultiWindow,
      {
        installStatus: enabledForWindows.status,
        ...multi,
        tabsChanged: afterMultiWindow !== beforeMultiWindow,
      }
    );

    if (!options.skipRestart) {
      phase = "restart";
      const expected = zones;
      await runAdapter(client, `return api.install({ enabled: true });`);
      const unlockedBeforeRestart = await runAdapter(
        client,
        `return api.setLocked(false);`
      );
      await shutdown();
      log("Restarting Zen with the same profile...");
      await launch();
      await waitForZenReady(client, options.timeoutMs);
      await ensureAdapter(client, 30_000, { installed: options.installed });
      const startupInstall = options.installed
        ? null
        : await runAdapter(
            client,
            `return await api.install({ enabled: true });`
          );
      const restoredSnapshot = await runAdapter(client, `return api.snapshot();`);
      const restored = zoneMap(restoredSnapshot, profileInfo.urls);
      const restoredProblems = expectZoneMap(restored, profileInfo.urls);
      record(
        "restart-restores-tabs",
        restoredProblems.length === 0,
        { expected, restored, problems: restoredProblems, windows: restoredSnapshot.windows.length }
      );
      const persistedLock = await runScript(
        client,
        `const win = [...Services.wm.getEnumerator("navigator:browser")][0];
const tab = win.gBrowser.addTab("about:blank", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  inBackground: true,
});
win.gBrowser.pinTab(tab);
const menu = win.document.getElementById("tabContextMenu");
win.TabContextMenu.contextTab = tab;
win.TabContextMenu.contextTabs = [tab];
win.TabContextMenu.multiselected = false;
win.TabContextMenu.updateContextMenu(menu);
const item = win.document.getElementById("context_svalinn-protect");
const result = {
  locked: globalThis.Svalinn.locked(),
  snapshotLocked: globalThis.Svalinn.snapshot().locked,
  pref: Services.prefs.getBoolPref("svalinn.locked", false),
  marker: win.document.documentElement.hasAttribute("svalinn-unlocked"),
  checked: Boolean(item?.checked),
  label: item?.getAttribute("label") ?? null,
};
win.gBrowser.removeTab(tab);
return result;`,
        { timeoutMs: 20_000 }
      );
      record(
        "restart-lock-persisted",
        unlockedBeforeRestart.status === "unlocked" &&
          persistedLock.locked === false &&
          persistedLock.snapshotLocked === false &&
          persistedLock.pref === false &&
          persistedLock.marker === true &&
          persistedLock.checked === false &&
          /unlocked/i.test(persistedLock.label ?? ""),
        { before: unlockedBeforeRestart.status, ...persistedLock }
      );
      const relockState = await runAdapter(
        client,
        `const result = api.setLocked(true);
         return {
           ...result,
           marker: win.document.documentElement.hasAttribute("svalinn-unlocked"),
           pref: Services.prefs.getBoolPref("svalinn.locked", false),
         };`
      );
      record(
        "restart-relock-restores",
        relockState.status === "locked" &&
          relockState.locked === true &&
          relockState.marker === false &&
          relockState.pref === true,
        relockState
      );
      const restoredInstall = options.installed
        ? { status: "already-installed" }
        : startupInstall;
      const afterRestartInstall = fingerprint(
        await runAdapter(client, `return api.snapshot();`)
      );
      const restoredHooks = await runAdapter(
        client,
        `return {
          drop: api.hookedWindows(),
          close: api.closeGuardedWindows(),
        };`
      );
      record(
        "restart-reattach-safe",
        ["installed", "already-installed"].includes(restoredInstall.status) &&
          restoredHooks.drop >= 1 &&
          restoredHooks.close >= 1 &&
          afterRestartInstall === fingerprint(restoredSnapshot),
        { status: restoredInstall.status, hooked: restoredHooks }
      );
    }

    phase = "shutdown";
    await shutdown();
    record("graceful-shutdown", processHandle.exited && processHandle.exitInfo?.code === 0, processHandle.exitInfo);

    phase = "done";
    report.ok = checks.every(check => check.ok);
    return report;
  } catch (error) {
    report.phase = phase;
    report.error = String(error?.message ?? error);
    if (error?.details !== undefined) report.errorDetails = error.details;
    if (processHandle && !processHandle.exited) {
      report.diagnostics = processHandle.diagnostics();
    }
    return report;
  } finally {
    if (client) {
      if (verified) {
        try {
          await client.quit();
        } catch {}
      }
      client.close();
    }
    await processHandle?.stop();
    if (profileInfo?.profile && !options.keepProfile && !options.profile) {
      await fs.rm(profileInfo.profile, { recursive: true, force: true }).catch(() => {});
    }
    report.durationMs = Date.now() - start;
  }
}

function printHelp() {
  console.log(`Svalinn Zen smoke test

Usage:
  npm run zen:smoke
  node src/zen/smoke.mjs [options]

Options:
  --zen <path>        Zen binary (default: zen-browser, or $SVALINN_ZEN_BIN)
  --profile <dir>     New/empty disposable profile directory
  --keep-profile      Keep a generated temporary profile for inspection
  --headless          Pass --headless to Zen
  --skip-restart      Skip the restart/session-restore phase
  --installed         Test a persistent autoconfig installation instead of
                      injecting through Marionette
  --install-root <dir> Disposable COPY of a Zen installation for --installed
                      (the live installation is refused)
  --skip-preflight    Skip the no-Marionette startup check (installed mode)
  --port <n>          Marionette port (default: 2828)
  --timeout <ms>      Startup/connect timeout (default: 60000)
  --json              Print the report as JSON
  -h, --help          Show this help

The test never uses ~/.zen: it refuses that profile and verifies the Marionette
session's moz:profile before executing any chrome-context script.
`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const report = await runSmoke(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("");
    for (const [index, check] of report.checks.entries()) {
      console.log(`${index + 1}. ${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    }
    if (report.error) console.log(`\nError (${report.phase}): ${report.error}`);
    if (report.diagnostics) console.log(`\nZen output:\n${report.diagnostics}`);
    if (report.warnings.length) console.log(`\nWarnings:\n- ${report.warnings.join("\n- ")}`);
    console.log(`\nResult: ${report.ok ? "PASS" : "FAIL"} (${report.durationMs} ms)`);
    const removed = !options.keepProfile && !options.profile;
    console.log(`Profile: ${report.profile}${removed ? " (removed)" : " (kept)"}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
