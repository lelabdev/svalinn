import assert from "node:assert/strict";
import test from "node:test";
import { probeCapabilities } from "../src/zen/capabilities.mjs";

function makeTab(essential = false) {
  return {
    pinned: true,
    hasAttribute: name => essential && name === "zen-essential",
  };
}

function makeScope(overrides = {}) {
  const scope = {
    Services: { appinfo: { name: "Zen", version: "1.23.4b" } },
    gBrowser: {
      tabs: [makeTab()],
      pinTab() {},
      unpinTab() {},
      addTab() {},
      duplicateTab() {},
      removeTab() {},
      removeTabs() {},
      removeCurrentTab() {},
      replaceTabsWithWindow() {},
      moveTabsBefore() {},
      moveTabTo() {},
      tabContainer: { tabDragAndDrop: { handle_drop() {} } },
    },
    gZenPinnedTabManager: {
      addToEssentials() {},
      removeEssentials() {},
      onCloseTabShortcut() {},
    },
    gZenStartup: { isReady: true },
    gZenWorkspaces: {},
    SessionStore: {},
  };
  return Object.assign(scope, overrides);
}

test("accepts the verified Zen chrome scope", () => {
  const report = probeCapabilities(makeScope());
  assert.equal(report.ok, true);
  assert.equal(report.isZen, true);
  assert.equal(report.versionStatus, "verified");
  assert.deepEqual(report.missing, []);
  assert.equal(report.tabShape, true);
});

test("rejects non-Zen browsers", () => {
  const report = probeCapabilities(
    makeScope({ Services: { appinfo: { name: "Firefox", version: "1.23.4b" } } })
  );
  assert.equal(report.ok, false);
  assert.equal(report.isZen, false);
  assert.ok(report.missing.includes("Services.appinfo.name=Zen"));
});

test("fails closed when the tab strip drop handler is unavailable", () => {
  const missingControl = makeScope();
  delete missingControl.gBrowser.tabContainer.tabDragAndDrop;
  const report = probeCapabilities(missingControl);
  assert.equal(report.ok, false);
  assert.ok(
    report.missing.includes("gBrowser.tabContainer.tabDragAndDrop")
  );

  const missingMethod = makeScope();
  delete missingMethod.gBrowser.tabContainer.tabDragAndDrop.handle_drop;
  const methodReport = probeCapabilities(missingMethod);
  assert.equal(methodReport.ok, false);
  assert.ok(
    methodReport.missing.includes(
      "gBrowser.tabContainer.tabDragAndDrop.handle_drop"
    )
  );
});

test("reports every missing or changed internal method", () => {
  const scope = makeScope();
  delete scope.gZenPinnedTabManager.removeEssentials;
  delete scope.gBrowser.pinTab;
  delete scope.gBrowser.removeTabs;
  delete scope.gBrowser.removeCurrentTab;
  const report = probeCapabilities(scope);
  assert.equal(report.ok, false);
  assert.ok(report.missing.includes("gZenPinnedTabManager.removeEssentials"));
  assert.ok(report.missing.includes("gBrowser.pinTab"));
  assert.ok(report.missing.includes("gBrowser.removeTabs"));
  assert.ok(report.missing.includes("gBrowser.removeCurrentTab"));
});

test("fails closed on unverified Zen versions unless explicitly allowed", () => {
  const scope = makeScope({
    Services: { appinfo: { name: "Zen", version: "1.24.0" } },
  });
  const blocked = probeCapabilities(scope);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.versionStatus, "unverified");
  assert.ok(blocked.missing.some(entry => entry.includes("not verified")));

  const allowed = probeCapabilities(scope, { allowUnverifiedVersion: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.versionStatus, "unverified");
});

test("detects an incompatible tab shape", () => {
  const report = probeCapabilities(
    makeScope({ gBrowser: { tabs: [{}], pinTab() {}, unpinTab() {}, addTab() {} } })
  );
  assert.equal(report.ok, false);
  assert.ok(report.missing.some(entry => entry.startsWith("tab shape")));
});

test("never throws for an empty or hostile scope", () => {
  assert.doesNotThrow(() => probeCapabilities(null));
  assert.equal(probeCapabilities(null).ok, false);

  const hostile = {
    get Services() {
      throw new Error("boom");
    },
    get gBrowser() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => probeCapabilities(hostile));
  assert.equal(probeCapabilities(hostile).ok, false);
});
