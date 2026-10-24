/**
 * Disposable-profile path safety shared by the smoke and manual launchers.
 *
 * Lexical prefix checks are not enough: a symlinked ancestor can redirect a
 * harmless-looking path into the user's real Zen profile. Resolve the real
 * destination (including missing final components) before writing anything.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Boundary-safe check (unlike string startsWith).
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path to its real location, allowing the final component(s) to be
 * missing. Existing symlinked ancestors are resolved first.
 *
 * @param {string} target
 * @returns {Promise<string>}
 */
export async function realpathAllowMissing(target) {
  let current = path.resolve(target);
  const missing = [];
  const seen = new Set();

  for (let depth = 0; depth < 40; depth += 1) {
    if (seen.has(current)) {
      throw new Error(`Symlink loop while resolving ${path.resolve(target)}`);
    }
    seen.add(current);

    try {
      const real = await fs.realpath(current);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }

      // A final symlink can point at a missing target. Resolve it explicitly
      // before treating the component as merely missing, otherwise a symlink
      // into ~/.zen could be created/written through unchecked.
      try {
        const entry = await fs.lstat(current);
        if (entry.isSymbolicLink()) {
          const link = await fs.readlink(current);
          current = path.resolve(path.dirname(current), link);
          continue;
        }
      } catch {
        // Component itself is missing; walk upward.
      }

      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }

  throw new Error(`Too many symlink levels while resolving ${path.resolve(target)}`);
}

/**
 * Reject the real ~/.zen tree (including symlinked aliases) before any write.
 *
 * @param {string} profile
 * @param {object} [options]
 * @param {string} [options.homeDir]
 * @returns {Promise<string>} canonical intended profile path
 */
export async function assertDisposableProfile(
  profile,
  { homeDir = os.homedir() } = {}
) {
  if (typeof profile !== "string" || profile.trim() === "") {
    throw new Error("A profile directory is required");
  }

  const homeZen = path.join(homeDir, ".zen");
  const realHomeZen = await realpathAllowMissing(homeZen);
  const realProfile = await realpathAllowMissing(profile);

  if (isPathInside(realProfile, realHomeZen)) {
    throw new Error(
      `Refusing to use the daily Zen profile: ${path.resolve(profile)} ` +
        `resolves to ${realProfile}`
    );
  }

  return realProfile;
}

/**
 * Compare two paths after resolving symlinks.
 *
 * @param {string} first
 * @param {string} second
 * @returns {Promise<boolean>}
 */
export async function sameRealPath(first, second) {
  const [a, b] = await Promise.all([
    realpathAllowMissing(first),
    realpathAllowMissing(second),
  ]);
  return a === b;
}
