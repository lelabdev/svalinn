import assert from "node:assert/strict";
import test from "node:test";
import {
  VERIFIED_ZEN_LINE,
  inspectZenVersion,
  parseZenVersion,
} from "../src/zen/version.mjs";

test("parses Zen release and prerelease versions", () => {
  assert.deepEqual(parseZenVersion("1.23.4"), {
    major: 1,
    minor: 23,
    patch: 4,
    prerelease: null,
    raw: "1.23.4",
  });
  assert.deepEqual(parseZenVersion(" 1.23.4b "), {
    major: 1,
    minor: 23,
    patch: 4,
    prerelease: "b",
    raw: "1.23.4b",
  });
  assert.equal(parseZenVersion("1.23.4-beta"), null);
});

test("rejects unparseable versions", () => {
  for (const value of [null, undefined, "", "Zen", "1", "1.2", "1.2.3.4"]) {
    assert.equal(parseZenVersion(value), null);
    assert.equal(inspectZenVersion(value).status, "unparseable");
  }
});

test("accepts only the verified release line by default", () => {
  assert.equal(inspectZenVersion("1.23.4b").status, "verified");
  assert.equal(inspectZenVersion("1.23.9").status, "verified");
  assert.equal(inspectZenVersion("1.24.0").status, "unverified");
  assert.equal(inspectZenVersion("2.23.0").status, "unverified");
  assert.deepEqual(VERIFIED_ZEN_LINE, { major: 1, minor: 23 });
});

test("supports an explicit verified line override", () => {
  assert.equal(
    inspectZenVersion("1.24.1", { verifiedLine: { major: 1, minor: 24 } })
      .status,
    "verified"
  );
});
