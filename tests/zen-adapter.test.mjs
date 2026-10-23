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
      duplicateTab() {},
      removeTab() {},
      moveTabsBefore() {},
      moveTabTo() {},
      tabContainer: {
        tabDragAndDrop: {
          handle_drop() {},
          _getDropIndex() {
            return 0;
          },
        },
      },
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
  const before = JSON.stringify(api.snapshot().windows.map(win => win.tabs));
  const report = api.uninstall();

  assert.equal(report.status, "uninstalled");
  assert.equal(window.__svalinn, undefined);
  assert.equal(observers.length, 1);
  assert.equal(JSON.stringify(api.snapshot().windows.map(win => win.tabs)), before);
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

function makeDropTab(url, { pinned = false, essential = false } = {}) {
  const attributes = new Set(essential ? ["zen-essential"] : []);
  return {
    id: `tab-${url}-${Math.random().toString(36).slice(2)}`,
    url,
    pinned,
    selected: false,
    linkedBrowser: { currentURI: { spec: url } },
    documentGlobal: null,
    hasAttribute: name => attributes.has(name),
    setAttribute(name) {
      if (name === "zen-essential") attributes.add(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

function makeDropEnvironment() {
  const stats = {
    nativeDrops: 0,
    duplicateCalls: 0,
    throwOnDuplicate: false,
    rejectEssentials: false,
    lazyDuplicate: false,
    selectedTab: null,
  };
  const tabs = [];
  const win = {};

  const gBrowser = {
    tabs,
    isTab: tab => tabs.includes(tab),
    addTab() {},
    pinTab(tab) {
      tab.pinned = true;
    },
    unpinTab(tab) {
      tab.pinned = false;
    },
    duplicateTab(source) {
      stats.duplicateCalls += 1;
      if (stats.throwOnDuplicate) throw new Error("duplicate failed");
      const copy = makeDropTab(`${source.url}#copy`, {
        pinned: source.pinned,
        essential: source.hasAttribute("zen-essential"),
      });
      copy.documentGlobal = win;
      if (stats.lazyDuplicate) {
        // SessionStore duplicates are restored asynchronously and initially
        // look like normal tabs, overwriting any category set too early.
        copy.id = "";
        copy.pinned = false;
        copy.removeAttribute("zen-essential");
        setTimeout(() => {
          copy.id = `restored-${stats.duplicateCalls}`;
          copy.pinned = false;
          copy.removeAttribute("zen-essential");
        }, 25);
      }
      tabs.push(copy);
      return copy;
    },
    removeTab(tab) {
      const index = tabs.indexOf(tab);
      if (index !== -1) tabs.splice(index, 1);
    },
    moveTabsBefore(moving, target) {
      for (const tab of [...moving].reverse()) {
        const index = tabs.indexOf(tab);
        if (index !== -1) tabs.splice(index, 1);
        const targetIndex = tabs.indexOf(target);
        tabs.splice(targetIndex === -1 ? tabs.length : targetIndex, 0, tab);
      }
    },
    moveTabTo(tab, { elementIndex }) {
      const index = tabs.indexOf(tab);
      if (index !== -1) tabs.splice(index, 1);
      tabs.splice(Math.min(elementIndex, tabs.length), 0, tab);
    },
    get selectedTab() {
      return stats.selectedTab;
    },
    set selectedTab(tab) {
      stats.selectedTab = tab;
    },
  };

  const nativeDrop = () => {
    stats.nativeDrops += 1;
  };
  const dnd = {
    handle_drop: nativeDrop,
    _getDropIndex: () => 0,
    _tabbrowserTabs: { dragAndDropElements: tabs },
  };
  gBrowser.tabContainer = { tabDragAndDrop: dnd };

  const manager = {
    addToEssentials(tab) {
      if (stats.rejectEssentials) return false;
      tab.pinned = true;
      tab.setAttribute("zen-essential");
      return true;
    },
    removeEssentials(tab, unpin = true) {
      tab.removeAttribute("zen-essential");
      if (unpin) tab.pinned = false;
    },
    onCloseTabShortcut() {},
  };

  Object.assign(win, {
    gBrowser,
    gZenPinnedTabManager: manager,
    gZenStartup: { isReady: true, promiseInitialized: Promise.resolve() },
    gZenWorkspaces: { promiseInitialized: Promise.resolve() },
    SessionStore: { promiseAllWindowsRestored: Promise.resolve() },
    delayedStartupPromise: Promise.resolve(),
    TAB_DROP_TYPE: "application/x-moz-tabbrowser-tab",
    addEventListener() {},
  });

  const addTab = (url, options) => {
    const tab = makeDropTab(url, options);
    tab.documentGlobal = win;
    tabs.push(tab);
    return tab;
  };

  return {
    win,
    tabs,
    stats,
    dnd,
    nativeDrop,
    addTab,
    drop(event, targetSelector = "normal") {
      const target = {
        closest: selector => {
          if (selector === ".zen-essentials-container") {
            return targetSelector === "essential" ? {} : null;
          }
          if (selector === ".zen-workspace-pinned-tabs-section") {
            return targetSelector === "pinned" ? {} : null;
          }
          if (selector === ".zen-workspace-normal-tabs-section") {
            return targetSelector === "normal" ? {} : null;
          }
          return null;
        },
      };
      return dnd.handle_drop({
        dataTransfer: {
          dropEffect: "move",
          mozTypesAt: () => ["application/x-moz-tabbrowser-tab"],
          mozGetDataAt: () => event.source,
        },
        target,
        preventDefault() {},
        stopPropagation() {},
      });
    },
  };
}

async function installDropEnvironment() {
  const env = makeDropEnvironment();
  const { api } = await makeContext({ windows: [env.win] });
  const report = await api.install({ enabled: true });
  assert.equal(report.status, "installed");
  return { ...env, api };
}

test("cross-zone drops duplicate and preserve the protected source", async () => {
  for (const [sourceZone, targetZone] of [
    ["essential", "normal"],
    ["essential", "pinned"],
    ["pinned", "normal"],
    ["pinned", "essential"],
  ]) {
    const env = await installDropEnvironment();
    const source = env.addTab(`https://${sourceZone}.test`, {
      pinned: true,
      essential: sourceZone === "essential",
    });
    source._dragData = { movingTabs: [source] };
    const before = env.tabs.length;

    env.drop({ source }, targetZone);

    const copies = env.tabs.filter(tab => tab !== source && tab.url.includes("#copy"));
    assert.equal(env.tabs.length, before + 1, `${sourceZone} -> ${targetZone}`);
    assert.equal(copies.length, 1);
    assert.equal(env.api.classify(source).zone, sourceZone);
    assert.equal(env.api.classify(copies[0]).zone, targetZone);
    assert.equal(env.stats.selectedTab, copies[0]);
    assert.equal(env.stats.nativeDrops, 0);
    assert.equal(env.stats.duplicateCalls, 1);
  }
});

test("applies the destination zone after lazy SessionStore restore", async () => {
  const env = await installDropEnvironment();
  env.stats.lazyDuplicate = true;
  const source = env.addTab("https://pinned.test", { pinned: true });
  const target = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "essential");
  await new Promise(resolve => setTimeout(resolve, 200));

  const copy = env.tabs.find(tab => tab !== source && tab !== target);
  assert.ok(copy, "expected a duplicated tab");
  assert.match(copy.id, /^restored-/);
  assert.equal(env.api.classify(copy).zone, "essential");
  assert.equal(env.api.classify(source).zone, "pinned");
  assert.equal(env.stats.nativeDrops, 0);
});

test("same-zone reordering and normal-tab drops stay native", async () => {
  for (const [sourceZone, targetZone, pinned, essential] of [
    ["pinned", "pinned", true, false],
    ["normal", "pinned", false, false],
    ["normal", "essential", false, false],
  ]) {
    const env = await installDropEnvironment();
    const source = env.addTab(`https://${sourceZone}.test`, {
      pinned,
      essential,
    });
    source._dragData = { movingTabs: [source] };
    const before = env.tabs.length;

    env.drop({ source }, targetZone);

    assert.equal(env.stats.nativeDrops, 1);
    assert.equal(env.stats.duplicateCalls, 0);
    assert.equal(env.tabs.length, before);
  }
});

test("duplication failures leave the protected source untouched", async () => {
  const env = await installDropEnvironment();
  const source = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  source._dragData = { movingTabs: [source] };
  env.stats.throwOnDuplicate = true;

  assert.doesNotThrow(() => env.drop({ source }, "normal"));
  assert.equal(env.stats.nativeDrops, 0);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "essential");
});

test("rejected Essential duplication removes the copy and keeps the source", async () => {
  const env = await installDropEnvironment();
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };
  env.stats.rejectEssentials = true;

  env.drop({ source }, "essential");

  assert.equal(env.stats.nativeDrops, 0);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");
});

test("cross-window and multi-tab drags stay native", async () => {
  const env = await installDropEnvironment();
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };

  source.documentGlobal = { gBrowser: {} };
  env.drop({ source }, "normal");
  assert.equal(env.stats.nativeDrops, 1);

  source.documentGlobal = env.win;
  const other = env.addTab("https://other.test");
  source._dragData = { movingTabs: [source, other] };
  env.drop({ source }, "normal");
  assert.equal(env.stats.nativeDrops, 2);
});

test("uninstall restores the native drop handler", async () => {
  const env = await installDropEnvironment();
  assert.equal(env.api.hookedWindows(), 1);
  assert.notEqual(env.dnd.handle_drop, env.nativeDrop);

  env.api.uninstall();

  assert.equal(env.api.hookedWindows(), 0);
  assert.equal(env.dnd.handle_drop, env.nativeDrop);
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };
  env.drop({ source }, "normal");
  assert.equal(env.stats.nativeDrops, 1);
});
