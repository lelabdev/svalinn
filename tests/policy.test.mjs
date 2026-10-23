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
