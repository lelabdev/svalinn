import assert from "node:assert/strict";
import test from "node:test";
import {
  ZONES,
  zoneOf,
  isProtected,
  decideAction,
  decideDrop,
  REMOVAL_ACTIONS,
} from "../src/policy.mjs";

const normal = { pinned: false, essential: false };
const pinned = { pinned: true, essential: false };
const essential = { pinned: true, essential: true };

test("classifies essentials before pinned tabs", () => {
  assert.equal(zoneOf(essential), ZONES.ESSENTIAL);
  assert.equal(zoneOf(pinned), ZONES.PINNED);
  assert.equal(zoneOf(normal), ZONES.NORMAL);
  assert.equal(isProtected(essential), true);
  assert.equal(isProtected(normal), false);
});

test("protects both pinned and essential tabs against removal", () => {
  for (const tab of [pinned, essential]) {
    for (const action of REMOVAL_ACTIONS) {
      assert.equal(decideAction({ tab, action }), "block", `${zoneOf(tab)} / ${action}`);
    }
  }
});

test("normal tabs are not affected", () => {
  for (const action of REMOVAL_ACTIONS) {
    assert.equal(decideAction({ tab: normal, action }), "allow");
  }
  assert.equal(decideDrop({ tab: normal, targetZone: "pinned" }), "native");
});

test("unloading protected tabs stays possible", () => {
  assert.equal(decideAction({ tab: pinned, action: "unload" }), "allow");
  assert.equal(decideAction({ tab: essential, action: "unload" }), "allow");
});

test("cross-category drop copies protected tabs without moving originals", () => {
  for (const [tab, targetZone] of [
    [essential, "pinned"],
    [essential, "normal"],
    [pinned, "essential"],
    [pinned, "normal"],
  ]) {
    assert.equal(decideDrop({ tab, targetZone }), "duplicate");
  }
});

test("reordering within a category is native", () => {
  assert.equal(decideDrop({ tab: pinned, targetZone: "pinned" }), "native");
  assert.equal(decideDrop({ tab: essential, targetZone: "essential" }), "native");
});

test("moving a protected tab across windows requests duplication", () => {
  assert.equal(decideDrop({ tab: pinned, targetZone: "pinned", sameWindow: false }), "duplicate");
  assert.equal(decideDrop({ tab: essential, targetZone: "essential", sameWindow: false }), "duplicate");
});

test("explicit temporary unlock allows removal and native movement", () => {
  for (const tab of [pinned, essential]) {
    for (const action of REMOVAL_ACTIONS) {
      assert.equal(decideAction({ tab, action, locked: false }), "allow");
    }
    assert.equal(decideDrop({ tab, targetZone: "normal", locked: false }), "native");
  }
});

test("unknown drop zones do not trigger destructive behavior", () => {
  assert.equal(decideDrop({ tab: essential, targetZone: "unknown" }), "unsupported");
});

const TAB_CASES = [
  ["normal", normal],
  ["pinned", pinned],
  ["essential", essential],
];

test("action matrix covers every tab type, removal action and unload", () => {
  const actions = [...REMOVAL_ACTIONS, "unload"];
  for (const [label, tab] of TAB_CASES) {
    for (const action of actions) {
      const expected =
        action === "unload" || label === "normal" ? "allow" : "block";
      assert.equal(decideAction({ tab, action }), expected, `${label}/${action}`);
      assert.equal(
        decideAction({ tab, action, locked: false }),
        "allow",
        `${label}/${action}/unlocked`
      );
    }
  }
  assert.equal(decideAction({ tab: pinned, action: "reload" }), "allow");
});

test("drop matrix covers every zone pair, window scope and lock state", () => {
  for (const [sourceLabel, tab] of TAB_CASES) {
    for (const targetZone of Object.values(ZONES)) {
      const sameZone = zoneOf(tab) === targetZone;
      const expectedSameWindow =
        sameZone || sourceLabel === "normal" ? "native" : "duplicate";
      const expectedCrossWindow =
        sourceLabel === "normal" ? "native" : "duplicate";
      assert.equal(
        decideDrop({ tab, targetZone }),
        expectedSameWindow,
        `${sourceLabel}->${targetZone}`
      );
      assert.equal(
        decideDrop({ tab, targetZone, sameWindow: false }),
        expectedCrossWindow,
        `${sourceLabel}->${targetZone}/cross-window`
      );
      assert.equal(
        decideDrop({ tab, targetZone, locked: false }),
        "native",
        `${sourceLabel}->${targetZone}/unlocked`
      );
    }
  }
});

test("unsupported target zones stay unsupported for every tab and lock state", () => {
  for (const [label, tab] of TAB_CASES) {
    for (const targetZone of ["folder", "", null, undefined, 42]) {
      assert.equal(
        decideDrop({ tab, targetZone }),
        "unsupported",
        `${label}/${String(targetZone)}`
      );
      assert.equal(
        decideDrop({ tab, targetZone, locked: false }),
        "unsupported",
        `${label}/${String(targetZone)}/unlocked`
      );
    }
  }
});

test("policy defaults are stateless and restore the locked default", () => {
  assert.equal(decideAction({ tab: pinned, action: "close", locked: false }), "allow");
  assert.equal(decideAction({ tab: pinned, action: "close" }), "block");
  assert.equal(decideDrop({ tab: essential, targetZone: "normal", locked: false }), "native");
  assert.equal(decideDrop({ tab: essential, targetZone: "normal" }), "duplicate");
  assert.equal(zoneOf(null), ZONES.NORMAL);
  assert.equal(isProtected(null), false);
  assert.equal(Object.isFrozen(ZONES), true);
  assert.equal(Object.isFrozen(REMOVAL_ACTIONS), true);
});
