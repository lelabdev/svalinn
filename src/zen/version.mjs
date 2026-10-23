/**
 * Zen version inspection shared by the browser adapter and Node tests.
 *
 * Zen's internal modules are not a stable public API. Svalinn therefore treats
 * a single Zen release line as verified and refuses to install on anything
 * else unless the caller opts into an unverified version.
 */

/**
 * The release line inspected and smoke-tested for this repository.
 * @type {{ major: number, minor: number }}
 */
export const VERIFIED_ZEN_LINE = Object.freeze({ major: 1, minor: 23 });

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:([a-z]+)(\d*))?$/i;

/**
 * Parse a Zen version string such as `1.23.4b`.
 *
 * @param {unknown} raw
 * @returns {null | { major: number, minor: number, patch: number, prerelease: string | null, raw: string }}
 */
export function parseZenVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, label, labelNumber] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: label ? `${label}${labelNumber ?? ""}` : null,
    raw: raw.trim(),
  };
}

/**
 * Decide whether a Zen version is in the verified release line.
 *
 * @param {unknown} raw
 * @param {object} [options]
 * @param {{ major: number, minor: number }} [options.verifiedLine]
 * @returns {{ status: "verified" | "unverified" | "unparseable", version: ReturnType<typeof parseZenVersion> }}
 */
export function inspectZenVersion(raw, { verifiedLine = VERIFIED_ZEN_LINE } = {}) {
  const version = parseZenVersion(raw);
  if (!version) return { status: "unparseable", version: null };
  const sameLine =
    version.major === verifiedLine.major &&
    version.minor === verifiedLine.minor;
  return { status: sameLine ? "verified" : "unverified", version };
}
