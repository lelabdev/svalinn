/**
 * Pure validation helpers for the manual Zen launcher.
 * Kept separate so tests never launch Zen or touch a real profile.
 */

import { sameRealPath } from "./profile.mjs";

/**
 * Validate the readiness/install/guard responses before printing the manual
 * checklist. Any failed or partial activation is an error.
 *
 * @param {object} input
 * @param {any} input.ready
 * @param {any} input.installed
 * @param {any} input.guards
 * @returns {{ ok: true, version: string|null } | { ok: false, error: string }}
 */
export function validateManualSession({ ready, installed, guards }) {
  if (!ready || ready.error || ready.ready !== true) {
    return {
      ok: false,
      error: `Zen startup failed: ${
        ready?.error ?? "readiness was not reported"
      }`,
    };
  }

  if (!installed || installed.error || installed.status !== "installed") {
    return {
      ok: false,
      error: `Svalinn install failed: ${
        installed?.error ??
        installed?.status ??
        "installation result was not reported"
      }`,
    };
  }

  const attached = Number(installed.windows);
  if (!Number.isInteger(attached) || attached < 1) {
    return {
      ok: false,
      error: `Svalinn install reported no attached window (windows=${installed.windows})`,
    };
  }

  if (!guards || typeof guards !== "object") {
    return {
      ok: false,
      error: "Svalinn guard state was not reported",
    };
  }

  const dropWindows = Number(guards.drop);
  const closeWindows = Number(guards.close);
  if (!Number.isInteger(dropWindows) || dropWindows < 1) {
    return {
      ok: false,
      error: `Svalinn drop guard is not attached (drop=${guards.drop})`,
    };
  }
  if (!Number.isInteger(closeWindows) || closeWindows < 1) {
    return {
      ok: false,
      error: `Svalinn close guard is not attached (close=${guards.close})`,
    };
  }

  const windows = Array.isArray(guards.windows) ? guards.windows : [];
  if (windows.length < 1 || windows.some(window => !window?.hooked)) {
    return {
      ok: false,
      error: "Svalinn drop hook is missing from one or more windows",
    };
  }
  if (windows.some(window => !window?.closeHooked)) {
    return {
      ok: false,
      error: "Svalinn close hook is missing from one or more windows",
    };
  }

  return { ok: true, version: ready.version ?? null };
}

/**
 * Confirm Marionette is attached to the intended profile, resolving symlinks.
 *
 * @param {string} sessionProfile
 * @param {string} expectedProfile
 * @returns {Promise<boolean>}
 */
export async function profileMatchesSession(sessionProfile, expectedProfile) {
  if (!sessionProfile || !expectedProfile) return false;
  return sameRealPath(sessionProfile, expectedProfile);
}
