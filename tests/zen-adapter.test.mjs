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
      removeTabs() {},
      removeCurrentTab() {},
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
    startup: { shuttingDown: false },
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
      attributes.add(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

function makeFakeDocument() {
  const elements = new Map();
  const menuListeners = new Map();

  const makeElement = (id, hidden = false) => {
    const attributes = new Map();
    return {
      id,
      hidden,
      attrs: attributes,
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      addEventListener() {},
      removeEventListener() {},
      remove() {
        elements.delete(id);
      },
    };
  };

  const menu = makeElement("tabContextMenu");
  menu.addEventListener = (type, listener) => {
    const entries = menuListeners.get(type) ?? [];
    entries.push(listener);
    menuListeners.set(type, entries);
  };
  menu.removeEventListener = (type, listener) => {
    const entries = menuListeners.get(type) ?? [];
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
  };
  menu.dispatchEvent = event => {
    for (const listener of menuListeners.get(event.type) ?? []) listener(event);
    return true;
  };

  elements.set("tabContextMenu", menu);
  for (const [id, hidden] of [
    ["context_closeTab", false],
    ["context_unpinTab", true],
    ["context_unpinSelectedTabs", true],
    ["context_zen-remove-essential", true],
  ]) {
    elements.set(id, makeElement(id, hidden));
  }

  const documentElement = {
    attributes: new Set(),
    hasAttribute(name) {
      return documentElement.attributes.has(name);
    },
    setAttribute(name) {
      documentElement.attributes.add(name);
    },
    removeAttribute(name) {
      documentElement.attributes.delete(name);
    },
    toggleAttribute(name, force) {
      const next =
        typeof force === "boolean"
          ? force
          : !documentElement.attributes.has(name);
      if (next) documentElement.attributes.add(name);
      else documentElement.attributes.delete(name);
      return next;
    },
    appendChild(node) {
      if (node?.id) elements.set(node.id, node);
    },
  };

  return {
    documentElement,
    getElementById: id => elements.get(id) ?? null,
    createElement: () => {
      const node = {
        id: "",
        textContent: "",
        remove() {
          if (node.id) elements.delete(node.id);
        },
      };
      return node;
    },
    elements,
    menu,
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
    removeTabCalls: 0,
    removeTabsCalls: 0,
    removeCurrentTabCalls: 0,
    removeGroupCalls: 0,
    unpinCalls: 0,
    removeEssentialsCalls: 0,
    unloadCalls: 0,
  };
  const tabs = [];
  const win = {};
  const listeners = new Map();
  const addEventListener = (type, listener) => {
    const entries = listeners.get(type) ?? [];
    entries.push(listener);
    listeners.set(type, entries);
  };
  const removeEventListener = (type, listener) => {
    const entries = listeners.get(type) ?? [];
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
  };
  const dispatchEvent = event => {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
    return true;
  };
  const emitRestored = tab => {
    win.dispatchEvent({ type: "SSTabRestored", target: tab });
  };

  const gBrowser = {
    tabs,
    isTab: tab => tabs.includes(tab),
    addTab() {},
    pinTab(tab) {
      tab.pinned = true;
    },
    unpinTab(tab) {
      stats.unpinCalls += 1;
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
      tabs.push(copy);

      if (stats.lazyDuplicate === "never") {
        return copy;
      }
      if (stats.lazyDuplicate === "with-id") {
        // Nonempty id is not a restoration signal; the zone is reset when the
        // simulated SessionStore restore finishes and SSTabRestored fires.
        setTimeout(() => {
          copy.pinned = false;
          copy.removeAttribute("zen-essential");
          emitRestored(copy);
        }, 25);
        return copy;
      }
      if (stats.lazyDuplicate) {
        copy.id = "";
        copy.pinned = false;
        copy.removeAttribute("zen-essential");
        setTimeout(() => {
          copy.id = `restored-${stats.duplicateCalls}`;
          copy.pinned = false;
          copy.removeAttribute("zen-essential");
          emitRestored(copy);
        }, 25);
        return copy;
      }

      emitRestored(copy);
      return copy;
    },
    removeTab(tab) {
      stats.removeTabCalls += 1;
      const index = tabs.indexOf(tab);
      if (index !== -1) tabs.splice(index, 1);
    },
    removeTabs(list) {
      stats.removeTabsCalls += 1;
      for (const tab of list) {
        const index = tabs.indexOf(tab);
        if (index !== -1) tabs.splice(index, 1);
      }
    },
    removeCurrentTab() {
      stats.removeCurrentTabCalls += 1;
      this.removeTab(this.selectedTab);
    },
    removeTabGroup(group) {
      stats.removeGroupCalls += 1;
      this.removeTabs(group.tabs);
      return Promise.resolve();
    },
    unloadTab(tab) {
      stats.unloadCalls += 1;
      tab.pending = true;
      return true;
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
      stats.removeEssentialsCalls += 1;
      tab.removeAttribute("zen-essential");
      if (unpin) tab.pinned = false;
    },
    onCloseTabShortcut() {},
  };

  const document = makeFakeDocument();

  Object.assign(win, {
    closed: false,
    document,
    TabContextMenu: { contextTab: null },
    gBrowser,
    gZenPinnedTabManager: manager,
    gZenStartup: { isReady: true, promiseInitialized: Promise.resolve() },
    gZenWorkspaces: {
      promiseInitialized: Promise.resolve(),
      _isClosingWindow: false,
    },
    SessionStore: { promiseAllWindowsRestored: Promise.resolve() },
    delayedStartupPromise: Promise.resolve(),
    TAB_DROP_TYPE: "application/x-moz-tabbrowser-tab",
    addEventListener,
    removeEventListener,
    dispatchEvent,
  });

  const addTab = (url, options) => {
    const tab = makeDropTab(url, options);
    tab.documentGlobal = win;
    tabs.push(tab);
    return tab;
  };

  return {
    win,
    document,
    tabs,
    stats,
    dnd,
    nativeDrop,
    addTab,
    drop(event, targetSelector = "normal") {
      const target = {
        closest: selector => {
          if (targetSelector === "unknown") return null;
          if (targetSelector === "throws") {
            throw new Error("closest failed");
          }
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

async function installDropEnvironment(options = {}) {
  const env = makeDropEnvironment();
  const { api, services } = await makeContext({ windows: [env.win] });
  const report = await api.install({ enabled: true, ...options });
  assert.equal(report.status, "installed");
  return { ...env, api, services };
}

test("active markers follow install, uninstall and failed install", async () => {
  const env = await installDropEnvironment();
  assert.equal(
    env.document.documentElement.hasAttribute("svalinn-active"),
    true
  );
  assert.ok(env.document.getElementById("svalinn-menu-style"));
  assert.equal(env.api.closeGuardedWindows(), 1);

  env.api.uninstall();
  assert.equal(
    env.document.documentElement.hasAttribute("svalinn-active"),
    false
  );
  assert.equal(env.document.getElementById("svalinn-menu-style"), null);
  assert.equal(env.api.closeGuardedWindows(), 0);

  const failed = makeDropEnvironment();
  failed.win.gBrowser.removeCurrentTab = undefined;
  const { api } = await makeContext({ windows: [failed.win] });
  const report = await api.install({ enabled: true });
  assert.equal(report.status, "unsupported");
  assert.equal(
    failed.document.documentElement.hasAttribute("svalinn-active"),
    false
  );
  assert.equal(failed.document.getElementById("svalinn-menu-style"), null);
  assert.equal(api.closeGuardedWindows(), 0);
});

test("context-menu blocking preserves Zen's native hidden states", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });
  const essential = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  const normal = env.addTab("https://normal.test");
  const doc = env.document;
  const menu = doc.menu;
  const close = doc.getElementById("context_closeTab");
  const unpin = doc.getElementById("context_unpinTab");
  const remove = doc.getElementById("context_zen-remove-essential");
  const blocked = id =>
    doc.getElementById(id).getAttribute("svalinn-blocked") === "true";

  const show = tab => {
    env.win.TabContextMenu.contextTab = tab;
    menu.dispatchEvent({ type: "popupshowing", target: menu });
  };

  close.hidden = false;
  unpin.hidden = false;
  remove.hidden = true;
  show(pinned);
  assert.equal(blocked("context_closeTab"), true);
  assert.equal(blocked("context_unpinTab"), true);
  assert.equal(close.hidden, false);
  assert.equal(unpin.hidden, false);
  assert.equal(remove.hidden, true);

  close.hidden = false;
  unpin.hidden = true;
  remove.hidden = true;
  show(normal);
  assert.equal(blocked("context_closeTab"), false);
  assert.equal(blocked("context_unpinTab"), false);
  assert.equal(blocked("context_zen-remove-essential"), false);
  assert.equal(close.hidden, false);
  assert.equal(unpin.hidden, true);
  assert.equal(remove.hidden, true);

  close.hidden = true;
  unpin.hidden = true;
  remove.hidden = false;
  show(essential);
  assert.equal(blocked("context_closeTab"), true);
  assert.equal(blocked("context_zen-remove-essential"), true);
  assert.equal(close.hidden, true);
  assert.equal(remove.hidden, false);

  env.api.uninstall();
  assert.equal(blocked("context_closeTab"), false);
  assert.equal(blocked("context_zen-remove-essential"), false);
});

test("blocks protected close gestures and keeps normal tabs closeable", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });
  const essential = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  const normal = env.addTab("https://normal.test");
  const normal2 = env.addTab("https://normal2.test");

  env.win.gBrowser.removeTab(pinned);
  env.win.gBrowser.removeTab(essential);
  assert.ok(env.tabs.includes(pinned));
  assert.ok(env.tabs.includes(essential));
  assert.equal(env.stats.removeTabCalls, 0);

  env.win.gBrowser.selectedTab = essential;
  env.win.gBrowser.removeCurrentTab();
  assert.ok(env.tabs.includes(essential));
  assert.equal(env.stats.removeCurrentTabCalls, 0);

  env.win.gBrowser.removeTab(normal);
  assert.equal(env.tabs.includes(normal), false);
  assert.equal(env.stats.removeTabCalls, 1);

  env.win.gBrowser.selectedTab = normal2;
  env.win.gBrowser.removeCurrentTab();
  assert.equal(env.tabs.includes(normal2), false);
  assert.equal(env.stats.removeCurrentTabCalls, 1);
});

test("mixed multi-close removes only normal tabs", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });
  const essential = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  const normal = env.addTab("https://normal.test");

  env.win.gBrowser.removeTabs([pinned, essential, normal]);

  assert.equal(env.tabs.includes(normal), false);
  assert.ok(env.tabs.includes(pinned));
  assert.ok(env.tabs.includes(essential));
  assert.equal(env.stats.removeTabsCalls, 1);

  env.win.gBrowser.removeTabs([pinned, essential]);
  assert.equal(env.stats.removeTabsCalls, 1);
  assert.ok(env.tabs.includes(pinned));
  assert.ok(env.tabs.includes(essential));
});

test("blocks unpin and Essential removal, including context-menu calls", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });
  const essential = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });

  env.win.gBrowser.unpinTab(pinned);
  assert.equal(pinned.pinned, true);
  assert.equal(env.stats.unpinCalls, 0);

  env.win.gZenPinnedTabManager.removeEssentials(essential);
  assert.equal(essential.hasAttribute("zen-essential"), true);
  assert.equal(env.stats.removeEssentialsCalls, 0);

  env.win.TabContextMenu = { contextTab: essential, multiselected: false };
  env.win.gZenPinnedTabManager.removeEssentials();
  assert.equal(essential.hasAttribute("zen-essential"), true);
  assert.equal(env.stats.removeEssentialsCalls, 0);
});

test("unloading protected tabs remains available", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });

  assert.equal(env.win.gBrowser.unloadTab(pinned), true);

  assert.equal(env.stats.unloadCalls, 1);
  assert.equal(pinned.pending, true);
  assert.ok(env.tabs.includes(pinned));
});

test("shutdown, startup and window-close bypasses allow native removal", async () => {
  const env = await installDropEnvironment();

  const shuttingDown = env.addTab("https://shutdown.test", { pinned: true });
  env.services.startup.shuttingDown = true;
  env.win.gBrowser.removeTab(shuttingDown);
  assert.equal(env.tabs.includes(shuttingDown), false);
  env.services.startup.shuttingDown = false;

  const starting = env.addTab("https://startup.test", { pinned: true });
  env.win.gZenStartup.isReady = false;
  env.win.gBrowser.removeTab(starting);
  assert.equal(env.tabs.includes(starting), false);
  env.win.gZenStartup.isReady = true;

  const closing = env.addTab("https://closing.test", { pinned: true });
  env.win.gZenWorkspaces._isClosingWindow = true;
  env.win.gBrowser.removeTab(closing);
  assert.equal(env.tabs.includes(closing), false);
  env.win.gZenWorkspaces._isClosingWindow = false;
});

test("blocks closing a group that contains a protected tab", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });
  const normal = env.addTab("https://normal.test");

  await env.win.gBrowser.removeTabGroup({ tabs: [pinned] });
  assert.ok(env.tabs.includes(pinned));
  assert.equal(env.stats.removeGroupCalls, 0);

  await env.win.gBrowser.removeTabGroup({ tabs: [normal] });
  assert.equal(env.tabs.includes(normal), false);
  assert.equal(env.stats.removeGroupCalls, 1);
});

test("uninstall restores close hooks", async () => {
  const env = await installDropEnvironment();
  const pinned = env.addTab("https://pinned.test", { pinned: true });

  assert.equal(env.api.closeGuardedWindows(), 1);
  env.api.uninstall();
  assert.equal(env.api.closeGuardedWindows(), 0);

  env.win.gBrowser.removeTab(pinned);
  assert.equal(env.tabs.includes(pinned), false);
});

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

test("unrecognized or unsafe protected targets are blocked, not native", async () => {
  for (const mode of ["unknown", "throws"]) {
    const env = await installDropEnvironment();
    const source = env.addTab("https://essential.test", {
      pinned: true,
      essential: true,
    });
    source._dragData = { movingTabs: [source] };
    const before = env.tabs.length;

    assert.doesNotThrow(() => env.drop({ source }, mode));

    assert.equal(env.stats.nativeDrops, 0, mode);
    assert.equal(env.stats.duplicateCalls, 0, mode);
    assert.equal(env.tabs.length, before, mode);
    assert.equal(env.api.classify(source).zone, "essential", mode);
    assert.equal(env.api.pendingDuplications(), 0, mode);
  }
});

test("protected planning errors fail closed without native demotion", async () => {
  const env = await installDropEnvironment();
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };
  env.dnd._getDropIndex = () => {
    throw new Error("drop index failed");
  };

  env.drop({ source }, "normal");

  assert.equal(env.stats.nativeDrops, 0);
  assert.equal(env.stats.duplicateCalls, 0);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");
});

test("normal sources still use native behavior for unknown targets", async () => {
  const env = await installDropEnvironment();
  const source = env.addTab("https://normal.test");
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "unknown");

  assert.equal(env.stats.nativeDrops, 1);
  assert.equal(env.stats.duplicateCalls, 0);
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
  assert.equal(env.api.pendingDuplications(), 0);
});

test("does not treat a nonempty id as proof of restoration", async () => {
  const env = await installDropEnvironment();
  env.stats.lazyDuplicate = "with-id";
  const source = env.addTab("https://pinned.test", { pinned: true });
  const target = env.addTab("https://essential.test", {
    pinned: true,
    essential: true,
  });
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "essential");
  assert.equal(env.api.pendingDuplications(), 1);
  assert.equal(env.api.classify(source).zone, "pinned");

  await new Promise(resolve => setTimeout(resolve, 200));

  const copy = env.tabs.find(tab => tab !== source && tab !== target);
  assert.ok(copy);
  assert.equal(env.api.classify(copy).zone, "essential");
  assert.equal(env.api.classify(source).zone, "pinned");
  assert.equal(env.api.pendingDuplications(), 0);
});

test("restore timeout removes the pending copy and keeps the source", async () => {
  const env = await installDropEnvironment({ restoreTimeoutMs: 20 });
  env.stats.lazyDuplicate = "never";
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "essential");
  assert.equal(env.api.pendingDuplications(), 1);
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(env.api.pendingDuplications(), 0);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");
});

test("uninstall cancels pending restoration before it can mutate tabs", async () => {
  const env = await installDropEnvironment();
  env.stats.lazyDuplicate = true;
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "essential");
  assert.equal(env.api.pendingDuplications(), 1);

  const report = env.api.uninstall();
  assert.equal(report.status, "uninstalled");
  assert.equal(env.api.pendingDuplications(), 0);
  assert.equal(env.dnd.handle_drop, env.nativeDrop);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");

  // Late restoration must not resurrect, move, select or recategorize a tab.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");
  assert.equal(env.api.pendingDuplications(), 0);

  const reinstall = await env.api.install({ enabled: true });
  assert.equal(reinstall.status, "installed");
  assert.equal(env.api.hookedWindows(), 1);
  assert.equal(env.dnd.handle_drop === env.nativeDrop, false);
});

test("window unload cancels pending restoration and detaches hooks", async () => {
  const env = await installDropEnvironment();
  env.stats.lazyDuplicate = true;
  const source = env.addTab("https://pinned.test", { pinned: true });
  source._dragData = { movingTabs: [source] };

  env.drop({ source }, "essential");
  assert.equal(env.api.pendingDuplications(), 1);

  env.win.dispatchEvent({ type: "unload", target: env.win });

  assert.equal(env.api.pendingDuplications(), 0);
  assert.equal(env.api.hookedWindows(), 0);
  assert.equal(env.dnd.handle_drop, env.nativeDrop);
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");

  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(env.tabs.length, 1);
  assert.equal(env.api.classify(source).zone, "pinned");
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
