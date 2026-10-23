import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { loadInjectionScript } from "../src/zen/build.mjs";

const SCRIPT = await loadInjectionScript();

function makeTab(url, { pinned = false, essential = false } = {}) {
  const attributes = new Set(essential ? ["zen-essential"] : []);
  return {
    id: `tab-${url}`,
    pinned,
    hasAttribute: name => attributes.has(name),
    linkedBrowser: { currentURI: { spec: url } },
  };
}

function makeWindow({
  name = "main",
  tabs = [],
  ready = true,
  readyPromise = Promise.resolve(),
  manager = true,
  sessionRestored = Promise.resolve(),
} = {}) {
  const listeners = new Map();
  const win = {
    name,
    closed: false,
    listeners,
    gBrowser: {
      tabs,
      pinTab() {},
      unpinTab() {},
      addTab() {},
    },
    gZenPinnedTabManager: manager
      ? {
          addToEssentials() {},
          removeEssentials() {},
          onCloseTabShortcut() {},
        }
      : undefined,
    gZenStartup: { isReady: ready, promiseInitialized: readyPromise },
    gZenWorkspaces: { promiseInitialized: Promise.resolve() },
    SessionStore: { promiseAllWindowsRestored: sessionRestored },
    delayedStartupPromise: Promise.resolve(),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  return win;
}

async function makeContext({
  windows = [makeWindow({ tabs: [makeTab("https://normal")] })],
  version = "1.23.4b",
  appName = "Zen",
  enabledPref = false,
} = {}) {
  const observers = [];
  const services = {
    appinfo: { name: appName, version },
    wm: { getEnumerator: () => windows.slice() },
    prefs: {
      getBoolPref: (name, fallback) =>
        name === "svalinn.enabled" ? enabledPref : fallback,
    },
    obs: {
      addObserver: (observer, topic) => observers.push({ observer, topic }),
      removeObserver: () => {},
    },
  };
  const context = vm.createContext({
    Services: services,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(SCRIPT, context, { filename: "svalinn-inject.js" });
  return { context, api: context.Svalinn, windows, observers, services };
}

test("classifies real tab shapes through the loaded policy", async () => {
  const { api } = await makeContext();
  assert.equal(api.policy.decideAction({ tab: { pinned: true }, action: "close" }), "block");
  assert.equal(
    api.policy.decideDrop({
      tab: { pinned: true },
      targetZone: "normal",
    }),
    "duplicate"
  );

  assert.equal(api.classify(makeTab("a")).zone, "normal");
  assert.equal(api.classify(makeTab("b", { pinned: true })).zone, "pinned");
  assert.equal(
    api.classify(makeTab("c", { pinned: true, essential: true })).zone,
    "essential"
  );
});

test("probe accepts a compatible Zen scope", async () => {
  const { api } = await makeContext();
  const report = api.probe();
  assert.equal(report.ok, true);
  assert.equal(report.isZen, true);
  assert.equal(report.versionStatus, "verified");
});

test("install is opt-in, then idempotent, and never reports tab changes", async () => {
  const normal = makeTab("https://normal");
  const window = makeWindow({ tabs: [normal] });
  const { api, observers } = await makeContext({
    windows: [window],
    enabledPref: false,
  });

  const disabled = await api.install();
  assert.equal(disabled.status, "disabled");
  assert.equal(window.__svalinn, undefined);
  assert.equal(observers.length, 0);

  const installed = await api.install({ enabled: true });
  assert.equal(installed.status, "installed");
  assert.equal(installed.changedTabs, false);
  assert.equal(window.__svalinn, api);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].topic, "domwindowopened");

  const again = await api.install({ enabled: true });
  assert.equal(again.status, "already-installed");
  assert.equal(observers.length, 1);
});

test("uninstall detaches markers and leaves tabs untouched", async () => {
  const tabs = [
    makeTab("https://normal"),
    makeTab("https://pinned", { pinned: true }),
    makeTab("https://essential", { pinned: true, essential: true }),
  ];
  const window = makeWindow({ tabs });
  const { api, observers } = await makeContext({ windows: [window] });

  await api.install({ enabled: true });
  const before = JSON.stringify(api.snapshot().windows);
  const report = api.uninstall();

  assert.equal(report.status, "uninstalled");
  assert.equal(window.__svalinn, undefined);
  assert.equal(observers.length, 1);
  assert.equal(JSON.stringify(api.snapshot().windows), before);
});

test("unsupported internals fail closed without attaching", async () => {
  const window = makeWindow({ tabs: [makeTab("https://normal")], manager: false });
  const { api, observers } = await makeContext({ windows: [window] });

  const report = await api.install({ enabled: true });
  assert.equal(report.status, "unsupported");
  assert.equal(window.__svalinn, undefined);
  assert.equal(observers.length, 0);
  assert.ok(
    report.capabilities.missing.includes("gZenPinnedTabManager")
  );
});

test("unverified Zen versions fail closed unless explicitly allowed", async () => {
  const window = makeWindow({ tabs: [makeTab("https://normal")] });
  const { api } = await makeContext({ windows: [window], version: "1.24.0" });

  const blocked = await api.install({ enabled: true });
  assert.equal(blocked.status, "unsupported");
  assert.equal(window.__svalinn, undefined);

  const allowed = await api.install({
    enabled: true,
    allowUnverifiedVersion: true,
  });
  assert.equal(allowed.status, "installed");
  assert.equal(window.__svalinn, api);
});

test("startup timing failures return not-ready before installing anything", async () => {
  const window = makeWindow({
    tabs: [makeTab("https://normal")],
    ready: false,
    readyPromise: new Promise(() => {}),
    sessionRestored: new Promise(() => {}),
  });
  const { api, observers } = await makeContext({ windows: [window] });

  const report = await api.install({ enabled: true, timeoutMs: 10 });
  assert.equal(report.status, "not-ready");
  assert.equal(report.changedTabs, false);
  assert.equal(window.__svalinn, undefined);
  assert.equal(observers.length, 0);
});

test("snapshots every window and attaches to windows opened later", async () => {
  const first = makeWindow({
    name: "first",
    tabs: [makeTab("https://one")],
  });
  const second = makeWindow({
    name: "second",
    tabs: [makeTab("https://two", { pinned: true })],
    ready: false,
  });
  const { api, observers } = await makeContext({ windows: [first] });

  await api.install({ enabled: true });
  const before = api.snapshot();
  assert.equal(before.windows.length, 1);
  assert.equal(before.windows[0].tabs[0].zone, "normal");

  const observer = observers[0].observer;
  observer.observe(second, "domwindowopened");
  second.listeners.get("load")();

  assert.equal(second.__svalinn, api);

  // The enumerator is captured when the context is created, so swap in both
  // windows and take a fresh snapshot.
  const { api: apiWithTwo } = await makeContext({
    windows: [first, second],
  });
  await apiWithTwo.install({ enabled: true });
  const snapshot = apiWithTwo.snapshot();
  assert.equal(snapshot.windows.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.windows.map(win => win.tabs.map(tab => tab.zone)))),
    [["normal"], ["pinned"]]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.windows.map(win => win.ready))),
    [true, false]
  );
});

test("hostile or missing globals never throw from install or snapshot", async () => {
  const window = makeWindow({ tabs: [makeTab("https://normal")] });
  const { api, services } = await makeContext({ windows: [window] });
  services.wm.getEnumerator = () => {
    throw new Error("enumeration failed");
  };

  assert.doesNotThrow(() => api.snapshot());
  assert.equal(api.snapshot().windows.length, 0);
  const report = await api.install({ enabled: true });
  assert.equal(report.status, "not-ready");
  assert.equal(window.__svalinn, undefined);
});
