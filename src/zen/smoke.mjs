#!/usr/bin/env node
/**
 * Svalinn smoke test for Zen Browser.
 *
 * Launches Zen with a disposable profile, injects the read-only adapter through
 * Marionette's chrome context, creates normal/Pinned/Essential tabs, verifies the
 * mapping, checks install/uninstall/disabled behaviour, restarts and verifies
 * session restore, then shuts down and removes the profile.
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

function assertDisposableProfile(profile) {
  const resolved = path.resolve(profile);
  const homeZen = path.join(os.homedir(), ".zen");
  if (
    resolved === path.resolve(homeZen) ||
    resolved.startsWith(`${path.resolve(homeZen)}${path.sep}`)
  ) {
    throw new SmokeError(
      `Refusing to use the daily Zen profile: ${resolved}. ` +
        "The smoke test only accepts a disposable profile."
    );
  }
}

export function profilePreferences(port) {
  const prefs = { ...PROFILE_PREFS, "marionette.port": port };
  return Object.entries(prefs)
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
    .join("\n");
}

/**
 * Create the disposable profile and its smoke pages.
 *
 * @param {object} options
 * @returns {Promise<{ profile: string, urls: Record<string, string>, created: boolean }>}
 */
async function prepareProfile({ profile, port }) {
  let created = false;
  if (profile) {
    assertDisposableProfile(profile);
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

  await fs.writeFile(
    path.join(profile, "user.js"),
    `// Generated by Svalinn smoke test.\n${profilePreferences(port)}\n`
  );

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

async function connectAndVerify({ client, profile, port, child }) {
  const session = await client.newSession();
  const capabilities = session?.capabilities ?? {};
  const remoteProfile = capabilities["moz:profile"];
  if (!remoteProfile) {
    throw new SmokeError(
      "Marionette session did not report moz:profile; aborting before chrome access"
    );
  }
  const sameProfile =
    path.resolve(remoteProfile) === path.resolve(profile);
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
const api = globalThis.Svalinn;
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

async function ensureAdapter(client, timeoutMs) {
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

const dropTab = async (source, target) => {
  dispatchDrop(source, target);
  await wait(250);
};

const dispatchDrop = (source, target) => {
  source._dragData = {
    movingTabs: [source],
    movingTabsSet: new Set([source]),
    fromTabList: false,
    dropElement: target,
    dropBefore: true,
    translateX: (target.screenX ?? 0) - (source.screenX ?? 0),
    translateY: (target.screenY ?? 0) - (source.screenY ?? 0),
    tabWidth: source.getBoundingClientRect().width || 200,
    tabHeight: source.getBoundingClientRect().height || 30,
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

await duplicateScenario("drag-essential-to-normal", essentialA, normalA, "normal");
await duplicateScenario("drag-pinned-to-normal", pinnedA, normalA, "normal");
await duplicateScenario("drag-pinned-to-essential", pinnedB, essentialB, "essential");
await duplicateScenario("drag-essential-to-pinned", essentialB, pinnedB, "pinned");
await nativeScenario("drag-same-zone-native", pinnedA, pinnedB, "pinned");
await nativeScenario("drag-normal-native", normalB, pinnedB, "pinned");

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
  reinstall.status === "installed" && api.hookedWindows() >= 1,
  { status: reinstall.status, hooked: api.hookedWindows() }
);

return {
  results,
  hooked: api.hookedWindows(),
  warnings: api.snapshot().warnings,
};`,
    { timeoutMs: 60_000 }
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
await wait(600);
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

    phase = "injection";
    const injected = await ensureAdapter(client, 30_000);
    record("adapter-injected", injected.adapter === "0.3.0" && injected.policy.length >= 4, injected);

    const probe = await runAdapter(
      client,
      `return api.probe({ allowUnverifiedVersion: false });`
    );
    record("capabilities", probe.ok === true && probe.isZen === true, probe);

    phase = "install";
    const installed = await runAdapter(
      client,
      `return await api.install({ enabled: true, waitForStartup: true, timeoutMs: 30000 });`
    );
    record("adapter-installed", installed.status === "installed" && installed.changedTabs === false, installed);

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
while (!second.__svalinn && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
const attached = Boolean(second.__svalinn);
const sameInstance = second.__svalinn === globalThis.Svalinn;
const firstAttached = Boolean(win.__svalinn);
const secondCloseHooked = Boolean(second.gBrowser.__svalinnCloseHook);
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
      await shutdown();
      log("Restarting Zen with the same profile...");
      await launch();
      await waitForZenReady(client, options.timeoutMs);
      await ensureAdapter(client, 30_000);
      const restoredSnapshot = await runAdapter(client, `return api.snapshot();`);
      const restored = zoneMap(restoredSnapshot, profileInfo.urls);
      const restoredProblems = expectZoneMap(restored, profileInfo.urls);
      record(
        "restart-restores-tabs",
        restoredProblems.length === 0,
        { expected, restored, problems: restoredProblems, windows: restoredSnapshot.windows.length }
      );
      const restoredInstall = await runAdapter(
        client,
        `return await api.install({ enabled: true });`
      );
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
        restoredInstall.status === "installed" &&
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
