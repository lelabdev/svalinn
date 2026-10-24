/**
 * Persistent personal installation for Svalinn.
 *
 * A minimal autoconfig bootloader is installed into Zen's installation
 * directory. It registers a profile-local chrome manifest and loads the trusted
 * Svalinn loader at startup. No Marionette or remote debugging port is used.
 *
 * The installation-root bootloader is a SHARED resource: every profile that has
 * Svalinn's profile-local manifest is bootstrapped by the same two files. A
 * small registry records which profiles still rely on it, so removing Svalinn
 * from one profile never disables protection in another.
 *
 * Install/update is transactional: a complete backup manifest and all backup
 * files are written before any target is modified, profile assets are written
 * first, and the shared bootloader is activated last. Any failure restores the
 * recorded previous state. Rollback validates the manifest and destination
 * identity before touching any file.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInjectionScript } from "./build.mjs";
import { inspectZenVersion } from "./version.mjs";
import { isPathInside, realpathAllowMissing } from "./profile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const persistentDir = path.join(here, "persistent");

export const USERJS_START = "// >>> Svalinn managed preferences >>>";
export const USERJS_END = "// <<< Svalinn managed preferences <<<";
export const CSS_START = "/* >>> Svalinn managed CSS >>> */";
export const CSS_END = "/* <<< Svalinn managed CSS <<< */";
export const DEFAULT_BACKUP_ROOT = profile =>
  path.join(profile, "svalinn-backup");

export const SHARED_FILES = [
  "svalinn.cfg",
  "defaults/pref/svalinn-autoconfig.js",
];
export const REGISTRY_FILE = "svalinn-registry.json";
export const REGISTRY_SCHEMA = 1;
export const BACKUP_SCHEMA = 1;
export const LOADER_VERSION = "0.1.0";

const OWNERSHIP_MARKERS = {
  "svalinn.cfg": "// Svalinn autoconfig bootloader.",
  "defaults/pref/svalinn-autoconfig.js":
    "// Svalinn managed autoconfig entry point.",
};

export class InstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallError";
  }
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function profileId(profile) {
  return sha256(profile).slice(0, 16);
}

async function listPrefFiles(root) {
  const dir = path.join(root, "defaults", "pref");
  try {
    return (await fs.readdir(dir))
      .filter(name => name.endsWith(".js"))
      .map(name => path.join(dir, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function lstatKind(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
    throw error;
  }
}

async function assertContained(root, target, label) {
  const [realRoot, realTarget] = await Promise.all([
    realpathAllowMissing(root),
    realpathAllowMissing(target),
  ]);
  if (!isPathInside(realTarget, realRoot)) {
    throw new InstallError(
      `${label} resolves outside its managed root: ${target} -> ${realTarget}`
    );
  }
  return realTarget;
}

/**
 * Verify that a path can be written as a regular file without following an
 * escaping symlink or replacing a directory. All parent directories must be
 * directories (or absent, so they can be created).
 */
async function assertFileTarget(root, relative, label) {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const kind = await lstatKind(current);
    if (kind !== "missing" && kind !== "dir") {
      throw new InstallError(
        `${label}: ${current} is not a directory, so ${relative} cannot be written`
      );
    }
  }
  const target = path.join(root, relative);
  const kind = await lstatKind(target);
  if (kind === "dir") {
    throw new InstallError(
      `${label}: ${target} is a directory, expected a file`
    );
  }
  if (kind === "symlink") await assertContained(root, target, label);
  return target;
}

function parseIni(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      current = { name: section[1].trim(), values: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    current.values[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim();
  }
  return sections;
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Resolve the ACTUAL browser profile directory.
 *
 * A path containing `profiles.ini` is Zen's profile container, not a browser
 * profile. Resolve its unambiguous default profile instead of writing user.js
 * and chrome assets into the container. Ambiguous containers are rejected with
 * an actionable error rather than guessed.
 */
export async function resolveProfileTarget(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new InstallError("A profile directory is required");
  }
  const container = await realpathAllowMissing(path.resolve(input));
  const containerKind = await lstatKind(container);
  if (containerKind !== "missing" && containerKind !== "dir") {
    throw new InstallError(
      `Profile path is not a directory: ${container}`
    );
  }
  const ini = await readIfExists(path.join(container, "profiles.ini"));
  if (ini === null) {
    return {
      profile: container,
      container: null,
      selectedBy: "direct",
      candidates: [],
    };
  }

  const sections = parseIni(ini);
  const profileSections = sections.filter(
    section => /^Profile\d+$/i.test(section.name) && section.values.Path
  );
  if (!profileSections.length) {
    throw new InstallError(
      `${container} contains profiles.ini but no usable [ProfileN] entries. ` +
        "Pass the actual profile directory explicitly."
    );
  }

  const candidates = [];
  for (const section of profileSections) {
    const isRelative = section.values.IsRelative !== "0";
    const rawPath = section.values.Path;
    if (path.isAbsolute(rawPath) !== !isRelative) {
      // IsRelative=0 paths are absolute; relative entries must not be absolute.
      continue;
    }
    const candidate = path.resolve(
      isRelative ? container : path.parse(rawPath).root,
      rawPath
    );
    const real = await realpathAllowMissing(candidate);
    if (isRelative && !isPathInside(real, container)) {
      throw new InstallError(
        `profiles.ini entry ${section.name} escapes the profile container: ${rawPath}`
      );
    }
    if (candidates.some(entry => entry.path === real)) continue;
    candidates.push({
      section: section.name,
      name: section.values.Name ?? null,
      path: real,
      default: section.values.Default === "1",
      exists: await isDirectory(real),
    });
  }

  if (!candidates.length) {
    throw new InstallError(
      `${container} contains profiles.ini but no resolvable profile directories.`
    );
  }

  const installDefaults = new Set();
  for (const section of sections) {
    if (!/^Install/i.test(section.name) || !section.values.Default) continue;
    const raw = section.values.Default;
    const resolved = path.resolve(
      path.isAbsolute(raw) ? path.parse(raw).root : container,
      raw
    );
    installDefaults.add(await realpathAllowMissing(resolved));
  }

  let selected = null;
  let selectedBy = null;
  if (installDefaults.size === 1) {
    const only = [...installDefaults][0];
    selected = candidates.find(entry => entry.path === only) ?? null;
    if (selected) selectedBy = "install-default";
  }
  if (!selected) {
    const defaults = candidates.filter(entry => entry.default);
    if (defaults.length === 1) {
      selected = defaults[0];
      selectedBy = "profile-default";
    }
  }
  if (!selected && candidates.length === 1) {
    selected = candidates[0];
    selectedBy = "only-profile";
  }

  if (!selected) {
    const listing = candidates
      .map(
        entry =>
          `  - ${entry.name ?? entry.section}: ${entry.path}` +
          (entry.default ? " (Default=1)" : "")
      )
      .join("\n");
    throw new InstallError(
      `${container} is a Zen profile container with several profiles and no ` +
        `unambiguous default. Pass the actual profile directory explicitly:\n${listing}\n` +
        "Do not install into the container itself."
    );
  }

  if (!selected.exists) {
    throw new InstallError(
      `profiles.ini selects ${selected.path} but that profile directory does not exist. ` +
        "Start Zen once with that profile or pass an existing profile directory."
    );
  }

  return {
    profile: selected.path,
    container,
    selectedBy,
    candidates,
  };
}

export async function inspectInstallRoot(root) {
  const resolved = await realpathAllowMissing(path.resolve(root));
  const ini = await readIfExists(path.join(resolved, "application.ini"));
  if (!ini) {
    throw new InstallError(
      `Not a Zen installation directory (missing application.ini): ${resolved}`
    );
  }
  const fields = Object.fromEntries(
    ini
      .split(/\r?\n/)
      .map(line => line.match(/^([^=]+)=(.*)$/))
      .filter(Boolean)
      .map(match => [match[1].trim(), match[2].trim()])
  );
  if (fields.Name && fields.Name !== "Zen") {
    throw new InstallError(
      `Installation is ${fields.Name}, not Zen: ${resolved}`
    );
  }
  if (fields.Name !== "Zen") {
    throw new InstallError(`Could not identify Zen in ${resolved}`);
  }
  const binaries = ["zen-bin", "zen"];
  let binary = null;
  for (const entry of binaries) {
    try {
      await fs.access(path.join(resolved, entry), fs.constants.X_OK);
      binary = path.join(resolved, entry);
      break;
    } catch {}
  }
  if (!binary) {
    throw new InstallError(
      `No Zen executable found in ${resolved} (expected zen-bin or zen)`
    );
  }
  return {
    root: resolved,
    binary,
    name: fields.Name,
    version: fields.Version ?? null,
  };
}

export async function detectInstallRoot() {
  const candidates = [
    process.env.SVALINN_ZEN_ROOT,
    "/opt/zen-browser-bin",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await inspectInstallRoot(candidate);
    } catch {}
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      const resolved = await fs.realpath(path.join(directory, "zen-browser"));
      const inspected = await inspectInstallRoot(path.dirname(resolved));
      return inspected;
    } catch {}
  }

  throw new InstallError(
    "Could not find Zen. Pass --install-root /path/to/zen."
  );
}

/**
 * Refuse to run the installed smoke test against a live Zen installation.
 * The harness must copy the installation and only mutate the copy.
 */
export async function assertDisposableInstallRoot(root) {
  const inspected = await inspectInstallRoot(root);
  const realRoot = await realpathAllowMissing(inspected.root);

  const candidates = [];
  if (process.env.SVALINN_ZEN_ROOT) {
    candidates.push(process.env.SVALINN_ZEN_ROOT);
  }
  candidates.push("/opt/zen-browser-bin");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      const resolved = await fs.realpath(path.join(directory, "zen-browser"));
      candidates.push(path.dirname(resolved));
    } catch {}
  }

  for (const candidate of candidates) {
    let realCandidate;
    try {
      realCandidate = await realpathAllowMissing(candidate);
    } catch {
      continue;
    }
    if (realCandidate === realRoot) {
      throw new InstallError(
        `Refusing to modify the live Zen installation at ${realRoot}. ` +
          "The smoke harness must run against a disposable copy; use " +
          "`npm run zen:installed-smoke`, which copies the installation first."
      );
    }
  }
  return realRoot;
}

export async function findAutoconfigConflict(root) {
  const conflicts = [];
  for (const file of await listPrefFiles(root)) {
    if (path.basename(file) === "svalinn-autoconfig.js") {
      const content = await readIfExists(file);
      if (content?.includes(OWNERSHIP_MARKERS[SHARED_FILES[1]])) continue;
    }
    const content = await readIfExists(file);
    if (content && /general\.config\.filename/.test(content)) {
      conflicts.push(file);
    }
  }
  return conflicts;
}

export function mergeManagedUserJs(
  content,
  { enabled = true, dragBehavior = "block" } = {}
) {
  const block = [
    USERJS_START,
    `user_pref("svalinn.enabled", ${JSON.stringify(Boolean(enabled))});`,
    `user_pref("svalinn.protectedDragBehavior", ${JSON.stringify(
      dragBehavior === "duplicate" ? "duplicate" : "block"
    )});`,
    `user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);`,
    USERJS_END,
  ].join("\n");

  const without = removeManagedUserJs(content ?? "");
  const prefix = without.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
}

export function removeManagedUserJs(content) {
  if (!content) return "";
  const escapedStart = USERJS_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = USERJS_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(
      new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"),
      "\n"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat(content.endsWith("\n") ? "\n" : "");
}

export function removeManagedCss(content) {
  if (!content) return "";
  const escapedStart = CSS_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = CSS_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(
      new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"),
      "\n"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat(content.endsWith("\n") ? "\n" : "");
}

export function mergeManagedCss(content, cssSource) {
  const block = [CSS_START, String(cssSource ?? "").trim(), CSS_END].join("\n");
  const without = removeManagedCss(content ?? "");
  const prefix = without.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
}

export async function readManagedState(profile) {
  const userJs = await readIfExists(path.join(profile, "user.js"));
  const text = userJs ?? "";
  const enabled =
    /user_pref\("svalinn\.enabled",\s*true\)/.test(text) &&
    text.includes(USERJS_START);
  const dragBehavior =
    /user_pref\("svalinn\.protectedDragBehavior",\s*"duplicate"\)/.test(text)
      ? "duplicate"
      : "block";
  return { hasManagedBlock: text.includes(USERJS_START), enabled, dragBehavior };
}

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.svalinn-${process.pid}.tmp`;
  await fs.writeFile(temp, content);
  await fs.rename(temp, file);
}

async function pruneEmptyParents(target, stopRoot) {
  let current = path.dirname(target);
  const stop = path.resolve(stopRoot);
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return;
      throw error;
    }
    current = path.dirname(current);
  }
}

export async function buildAssets() {
  return {
    install: {
      "svalinn.cfg": await readIfExists(path.join(persistentDir, "svalinn.cfg")),
      "defaults/pref/svalinn-autoconfig.js": await readIfExists(
        path.join(persistentDir, "svalinn-autoconfig.js")
      ),
    },
    profile: {
      "chrome/svalinn/chrome.manifest": await readIfExists(
        path.join(persistentDir, "chrome.manifest")
      ),
      "chrome/svalinn/content/loader.sys.mjs": await readIfExists(
        path.join(persistentDir, "loader.sys.mjs")
      ),
      "chrome/svalinn/content/adapter.js": await loadInjectionScript(),
      "chrome/svalinn/version.json": `${JSON.stringify(
        { loader: LOADER_VERSION, installedAt: new Date().toISOString() },
        null,
        2
      )}\n`,
    },
    css: await readIfExists(path.resolve(here, "../../userChrome.css")),
  };
}

function emptyRegistry(installRoot) {
  const now = new Date().toISOString();
  return {
    schema: REGISTRY_SCHEMA,
    managedBy: "svalinn",
    installRoot,
    createdAt: now,
    updatedAt: now,
    profiles: [],
  };
}

function validateRegistry(registry, installRoot) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new InstallError("Svalinn registry is not a JSON object");
  }
  if (registry.schema !== REGISTRY_SCHEMA) {
    throw new InstallError(
      `Unsupported Svalinn registry schema: ${registry.schema}`
    );
  }
  if (registry.managedBy !== "svalinn") {
    throw new InstallError("Svalinn registry has an unknown owner");
  }
  if (
    typeof registry.installRoot !== "string" ||
    path.resolve(registry.installRoot) !== installRoot
  ) {
    throw new InstallError(
      `Svalinn registry belongs to a different installation root: ${registry.installRoot}`
    );
  }
  if (!Array.isArray(registry.profiles)) {
    throw new InstallError("Svalinn registry profiles must be an array");
  }
  const paths = new Set();
  const ids = new Set();
  for (const entry of registry.profiles) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !/^[a-f0-9]{16}$/.test(entry.id) ||
      typeof entry.path !== "string"
    ) {
      throw new InstallError("Svalinn registry contains an invalid profile entry");
    }
    if (path.resolve(entry.path) !== entry.path) {
      throw new InstallError(
        `Svalinn registry contains a non-canonical profile path: ${entry.path}`
      );
    }
    if (entry.id !== profileId(entry.path)) {
      throw new InstallError(
        `Svalinn registry profile id does not match its path: ${entry.path}`
      );
    }
    if (paths.has(entry.path) || ids.has(entry.id)) {
      throw new InstallError(
        `Svalinn registry contains duplicate profile entries: ${entry.path}`
      );
    }
    paths.add(entry.path);
    ids.add(entry.id);
  }
  return registry;
}

async function readRegistry(installRoot) {
  const file = path.join(installRoot, REGISTRY_FILE);
  const text = await readIfExists(file);
  if (text === null) {
    return { state: "missing", registry: null, file, error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      state: "invalid",
      registry: null,
      file,
      error: `Cannot parse ${file}: ${error.message}`,
    };
  }
  try {
    validateRegistry(parsed, installRoot);
  } catch (error) {
    return { state: "invalid", registry: null, file, error: error.message };
  }
  return { state: "valid", registry: parsed, file, error: null };
}

function addRegistryProfile(registry, profile) {
  const id = profileId(profile);
  if (registry.profiles.some(entry => entry.path === profile)) return registry;
  return {
    ...registry,
    updatedAt: new Date().toISOString(),
    profiles: [...registry.profiles, { id, path: profile }],
  };
}

function removeRegistryProfile(registry, profile) {
  return {
    ...registry,
    updatedAt: new Date().toISOString(),
    profiles: registry.profiles.filter(entry => entry.path !== profile),
  };
}

async function profileHasLoader(profile) {
  return (
    (await readIfExists(
      path.join(profile, "chrome", "svalinn", "content", "loader.sys.mjs")
    )) !== null
  );
}

/**
 * Drop registrations that are provably inactive (profile removed, or its
 * Svalinn loader is gone). Permission/other errors keep the entry: uncertain
 * ownership is never treated as safe to delete.
 */
async function pruneRegistryProfiles(registry) {
  const profiles = [];
  for (const entry of registry.profiles) {
    let directory = false;
    try {
      directory = await isDirectory(entry.path);
    } catch {
      profiles.push(entry);
      continue;
    }
    if (!directory) continue;
    try {
      if (await profileHasLoader(entry.path)) profiles.push(entry);
    } catch {
      profiles.push(entry);
    }
  }
  return { ...registry, updatedAt: new Date().toISOString(), profiles };
}

async function inspectSharedBootstrap(installRoot) {
  const files = {};
  for (const relative of SHARED_FILES) {
    const content = await readIfExists(path.join(installRoot, relative));
    files[relative] =
      content === null
        ? "missing"
        : content.includes(OWNERSHIP_MARKERS[relative])
          ? "managed"
          : "foreign";
  }
  const values = Object.values(files);
  return {
    files,
    present: values.every(value => value !== "missing"),
    managed: values.every(value => value === "managed"),
    foreign: Object.keys(files).filter(key => files[key] === "foreign"),
  };
}

async function writeSharedBootstrap(installRoot, assets, warnings) {
  for (const relative of SHARED_FILES) {
    const target = path.join(installRoot, relative);
    const existing = await readIfExists(target);
    if (existing !== null && !existing.includes(OWNERSHIP_MARKERS[relative])) {
      warnings.push(
        `Kept foreign file ${target}; Svalinn did not overwrite it.`
      );
      continue;
    }
    await writeAtomic(target, assets.install[relative]);
  }
}

async function removeSharedBootstrap(installRoot, warnings) {
  for (const relative of SHARED_FILES) {
    const target = path.join(installRoot, relative);
    const existing = await readIfExists(target);
    if (existing === null) continue;
    if (!existing.includes(OWNERSHIP_MARKERS[relative])) {
      warnings.push(`Kept foreign file ${target}; Svalinn did not remove it.`);
      continue;
    }
    await fs.rm(target, { force: true });
  }
}

async function writeRegistryState(installRoot, registry, warnings) {
  const file = path.join(installRoot, REGISTRY_FILE);
  if (registry.profiles.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  validateRegistry(registry, installRoot);
  await writeAtomic(file, `${JSON.stringify(registry, null, 2)}\n`);
  warnings.push(
    `Svalinn remains active for ${registry.profiles.length} registered profile(s); ` +
      "shared bootloader retained."
  );
}

/**
 * Reconcile registry + shared bootloader for a set of registered profiles.
 * When ownership is uncertain the shared files are retained.
 */
async function reconcileSharedState({
  installRoot,
  registry,
  profiles,
  assets,
  warnings,
  conservativeKeep = false,
  restoreShared = null,
}) {
  if (profiles.length > 0) {
    const next = {
      ...(registry ?? emptyRegistry(installRoot)),
      installRoot,
      updatedAt: new Date().toISOString(),
      profiles,
    };
    await writeRegistryState(installRoot, next, warnings);
    await writeSharedBootstrap(installRoot, assets, warnings);
    return { remainingProfiles: profiles.length, sharedRetained: true };
  }

  if (conservativeKeep) {
    warnings.push(
      "Svalinn ownership of the shared installation-root bootloader is uncertain; " +
        "it was retained. Remove it manually only after checking every Zen profile."
    );
    return { remainingProfiles: 0, sharedRetained: true };
  }

  if (restoreShared?.length) {
    for (const operation of restoreShared) {
      if (operation.existed) {
        await writeAtomic(operation.target, operation.content);
      } else {
        await fs.rm(operation.target, { force: true });
        await pruneEmptyParents(operation.target, operation.root);
      }
    }
  } else {
    await removeSharedBootstrap(installRoot, warnings);
  }
  await fs.rm(path.join(installRoot, REGISTRY_FILE), { force: true });
  return { remainingProfiles: 0, sharedRetained: false };
}

const ALLOWED_PROFILE_FILES = new Set(["user.js", "chrome/userChrome.css"]);

function isAllowedManagedPath(base, relative) {
  if (base === "install") {
    return SHARED_FILES.includes(relative) || relative === REGISTRY_FILE;
  }
  if (base !== "profile") return false;
  if (ALLOWED_PROFILE_FILES.has(relative)) return true;
  return (
    relative.startsWith("chrome/svalinn/") &&
    relative.length > "chrome/svalinn/".length
  );
}

function validateRelativePath(base, relative) {
  if (typeof relative !== "string" || relative === "") {
    throw new InstallError("Backup manifest contains an empty file path");
  }
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes("\0")
  ) {
    throw new InstallError(
      `Backup manifest contains an unsafe path: ${relative}`
    );
  }
  const normalized = path.normalize(relative);
  if (
    normalized !== relative ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new InstallError(
      `Backup manifest path escapes its root: ${relative}`
    );
  }
  if (
    relative
      .split("/")
      .some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw new InstallError(
      `Backup manifest contains an invalid path segment: ${relative}`
    );
  }
  if (!isAllowedManagedPath(base, relative)) {
    throw new InstallError(
      `Backup manifest references a file Svalinn does not manage: ${base}:${relative}`
    );
  }
}

async function backupPreviousFile({
  base,
  root,
  relative,
  backupDir,
  records,
}) {
  const target = path.join(root, relative);
  const content = await readIfExists(target);
  const record = {
    base,
    relative,
    existed: content !== null,
    sha256: content === null ? null : sha256(content),
  };
  records.push(record);
  if (content !== null) {
    const source = path.join(backupDir, base, relative);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, content);
  }
  return content;
}

async function writeBackupManifest(backupDir, manifest) {
  await writeAtomic(
    path.join(backupDir, "backup.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

async function validateBackupManifest({
  backupDir,
  installRoot,
  profile,
}) {
  const manifestPath = path.join(backupDir, "backup.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new InstallError(
      `Cannot read Svalinn backup manifest ${manifestPath}: ${error.message}`
    );
  }

  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schema !== BACKUP_SCHEMA ||
    manifest.managedBy !== "svalinn"
  ) {
    throw new InstallError(
      `Unsupported or malformed Svalinn backup manifest: ${manifestPath}`
    );
  }
  if (!["prepared", "completed"].includes(manifest.status)) {
    throw new InstallError(
      `Svalinn backup manifest has an unknown status: ${manifest.status}`
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new InstallError("Svalinn backup manifest lists no files");
  }
  if (
    typeof manifest.profile !== "string" ||
    typeof manifest.installRoot !== "string" ||
    manifest.profile === "" ||
    manifest.installRoot === ""
  ) {
    throw new InstallError(
      "Svalinn backup manifest does not record its profile and installation root"
    );
  }

  const [manifestProfile, requestedProfile, manifestRoot, requestedRoot] =
    await Promise.all([
      realpathAllowMissing(manifest.profile),
      realpathAllowMissing(profile),
      realpathAllowMissing(manifest.installRoot),
      realpathAllowMissing(installRoot),
    ]);
  if (manifestProfile !== requestedProfile) {
    throw new InstallError(
      `Backup belongs to profile ${manifestProfile}, not ${requestedProfile}. ` +
        "Refusing to restore into a different profile."
    );
  }
  if (manifestRoot !== requestedRoot) {
    throw new InstallError(
      `Backup belongs to installation ${manifestRoot}, not ${requestedRoot}. ` +
        "Refusing to restore into a different installation."
    );
  }

  const seen = new Set();
  const operations = [];
  for (const record of manifest.files) {
    if (!record || typeof record !== "object") {
      throw new InstallError("Svalinn backup manifest contains an invalid record");
    }
    const { base, relative } = record;
    validateRelativePath(base, relative);
    const key = `${base}:${relative}`;
    if (seen.has(key)) {
      throw new InstallError(
        `Svalinn backup manifest contains a duplicate record: ${key}`
      );
    }
    seen.add(key);
    if (typeof record.existed !== "boolean") {
      throw new InstallError(
        `Svalinn backup manifest record lacks an existed flag: ${key}`
      );
    }
    if (
      record.expectedSha256 !== undefined &&
      (typeof record.expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.expectedSha256))
    ) {
      throw new InstallError(
        `Svalinn backup manifest has an invalid expected hash for ${key}`
      );
    }

    const root = base === "install" ? installRoot : profile;
    const target = path.join(root, relative);
    await assertContained(root, target, `Backup target ${key}`);
    const kind = await lstatKind(target);
    if (kind === "dir") {
      throw new InstallError(
        `Backup target is a directory, refusing to restore ${key}: ${target}`
      );
    }
    const segments = relative.split("/");
    let ancestor = root;
    for (const segment of segments.slice(0, -1)) {
      ancestor = path.join(ancestor, segment);
      const ancestorKind = await lstatKind(ancestor);
      if (ancestorKind !== "missing" && ancestorKind !== "dir") {
        throw new InstallError(
          `Backup target ancestor is not a directory: ${ancestor}`
        );
      }
    }

    let content = null;
    if (record.existed) {
      if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
        throw new InstallError(
          `Svalinn backup manifest lacks a valid hash for ${key}`
        );
      }
      const source = path.join(backupDir, base, relative);
      await assertContained(backupDir, source, `Backup content ${key}`);
      const restored = await readIfExists(source);
      if (restored === null) {
        throw new InstallError(
          `Svalinn backup is missing content for ${key}: ${source}`
        );
      }
      if (sha256(restored) !== record.sha256) {
        throw new InstallError(
          `Svalinn backup content failed its hash check for ${key}`
        );
      }
      content = restored;
    }

    operations.push({ ...record, target, root, content });
  }

  return { manifest, operations };
}

async function applyRestore(operations) {
  for (const operation of operations) {
    if (operation.existed) {
      await writeAtomic(operation.target, operation.content);
    } else {
      await fs.rm(operation.target, { force: true });
      await pruneEmptyParents(operation.target, operation.root);
    }
  }
}

function isSharedRecord(record) {
  return (
    record.base === "install" &&
    (SHARED_FILES.includes(record.relative) ||
      record.relative === REGISTRY_FILE)
  );
}

/**
 * Install or update Svalinn in a Zen installation and profile.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function install({
  profile: profileInput,
  installRoot,
  backupRoot = null,
  enabled = true,
  dragBehavior = "block",
  allowUnverifiedVersion = false,
  force = false,
  __testFailAt = null,
}) {
  if (!profileInput) throw new InstallError("A profile directory is required");
  const target = await resolveProfileTarget(profileInput);
  const profile = target.profile;

  const installation = await inspectInstallRoot(installRoot);
  try {
    await fs.access(installation.root, fs.constants.W_OK);
  } catch {
    throw new InstallError(
      `Zen installation root is not writable: ${installation.root}. ` +
        "Close Zen and rerun with sufficient permission (see docs/persistent-install.md)."
    );
  }
  const version = inspectZenVersion(installation.version);
  if (version.status !== "verified" && !allowUnverifiedVersion) {
    throw new InstallError(
      `Zen ${installation.version ?? "unknown"} is not a verified version ` +
        `(${version.status}). Pass --allow-unverified-version to override.`
    );
  }

  const conflicts = await findAutoconfigConflict(installation.root);
  if (conflicts.length && !force) {
    throw new InstallError(
      `Another autoconfig loader is already configured: ${conflicts.join(", ")}. ` +
        "Refusing to overwrite it; remove it or pass --force after review."
    );
  }

  const shared = await inspectSharedBootstrap(installation.root);
  if (shared.foreign.length && !force) {
    throw new InstallError(
      `Installation-root file(s) already exist but were not created by Svalinn: ` +
        `${shared.foreign.join(", ")}. Refusing to overwrite them merely by name; ` +
        "review them and pass --force if they are safe to replace."
    );
  }

  const registryState = await readRegistry(installation.root);
  if (registryState.state === "invalid") {
    throw new InstallError(
      `Svalinn shared registry is invalid: ${registryState.error}. ` +
        `Inspect ${registryState.file} before installing; Svalinn will not ` +
        "overwrite an uncertain ownership record."
    );
  }

  await fs.mkdir(profile, { recursive: true });
  try {
    await fs.access(profile, fs.constants.W_OK);
  } catch {
    throw new InstallError(`Profile directory is not writable: ${profile}`);
  }

  const assets = await buildAssets();
  for (const [relative, content] of Object.entries(assets.install)) {
    if (!content) {
      throw new InstallError(`Missing installer asset: ${relative}`);
    }
  }
  for (const [relative, content] of Object.entries(assets.profile)) {
    if (!content) {
      throw new InstallError(`Missing profile asset: ${relative}`);
    }
  }
  if (!assets.css) {
    throw new InstallError("Missing userChrome.css source in the repository");
  }

  // Preflight every target before creating a backup or writing anything.
  for (const relative of [...SHARED_FILES, REGISTRY_FILE]) {
    await assertFileTarget(
      installation.root,
      relative,
      "Installation root"
    );
  }
  for (const relative of [
    ...Object.keys(assets.profile),
    "chrome/userChrome.css",
    "user.js",
  ]) {
    await assertFileTarget(profile, relative, "Profile");
  }

  const timestamp = `${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = path.join(
    backupRoot ?? DEFAULT_BACKUP_ROOT(profile),
    timestamp
  );
  try {
    await fs.mkdir(backupDir, { recursive: true });
  } catch (error) {
    throw new InstallError(
      `Cannot create backup directory ${backupDir}: ${error.message}`
    );
  }

  const previousUserJs = await readIfExists(path.join(profile, "user.js"));
  const previousCss =
    (await readIfExists(path.join(profile, "chrome", "userChrome.css"))) ?? "";
  const baseRegistry =
    registryState.registry ?? emptyRegistry(installation.root);
  const nextRegistry = addRegistryProfile(
    await pruneRegistryProfiles(baseRegistry),
    profile
  );

  const writes = [
    ...Object.entries(assets.profile).map(([relative, content]) => ({
      base: "profile",
      root: profile,
      relative,
      content,
    })),
    {
      base: "profile",
      root: profile,
      relative: "chrome/userChrome.css",
      content: mergeManagedCss(previousCss, assets.css),
    },
    {
      base: "profile",
      root: profile,
      relative: "user.js",
      content: mergeManagedUserJs(previousUserJs ?? "", {
        enabled,
        dragBehavior,
      }),
    },
    {
      base: "install",
      root: installation.root,
      relative: REGISTRY_FILE,
      content: `${JSON.stringify(nextRegistry, null, 2)}\n`,
    },
    ...SHARED_FILES.map(relative => ({
      base: "install",
      root: installation.root,
      relative,
      content: assets.install[relative],
    })),
  ];

  const records = [];
  let manifestWritten = false;
  try {
    for (const write of writes) {
      await backupPreviousFile({
        base: write.base,
        root: write.root,
        relative: write.relative,
        backupDir,
        records,
      });
    }
    for (const [index, write] of writes.entries()) {
      records[index].expectedSha256 = sha256(write.content);
    }

    const manifest = {
      schema: BACKUP_SCHEMA,
      managedBy: "svalinn",
      status: "prepared",
      createdAt: new Date().toISOString(),
      installRoot: installation.root,
      profile,
      version: installation.version,
      files: records,
    };
    await writeBackupManifest(backupDir, manifest);
    manifestWritten = true;

    for (const write of writes) {
      if (__testFailAt === write.relative) {
        const error = new Error(`Injected write failure for ${write.relative}`);
        error.code = "ENOSPC";
        throw error;
      }
      await writeAtomic(path.join(write.root, write.relative), write.content);
    }

    manifest.status = "completed";
    await writeBackupManifest(backupDir, manifest);

    return {
      status: "installed",
      installRoot: installation.root,
      binary: installation.binary,
      zenVersion: installation.version,
      profile,
      profileContainer: target.container,
      backupDir,
      files: writes.map(write => write.relative),
      registeredProfiles: nextRegistry.profiles.length,
    };
  } catch (error) {
    if (!manifestWritten) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      throw new InstallError(
        `Installation failed before any target was changed: ${error.message}`
      );
    }
    let restored = false;
    try {
      const { operations } = await validateBackupManifest({
        backupDir,
        installRoot: installation.root,
        profile,
      });
      await applyRestore(operations);
      restored = true;
    } catch (restoreError) {
      throw new InstallError(
        `Installation failed: ${error.message}. Automatic restore also failed ` +
          `(${restoreError.message}); recovery backup kept at ${backupDir}.`
      );
    }
    if (restored) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
    throw new InstallError(
      `Installation failed: ${error.message}. Previous files were restored.`
    );
  }
}

export async function uninstall({ profile: profileInput, installRoot }) {
  const target = await resolveProfileTarget(profileInput);
  const profile = target.profile;
  const installation = await inspectInstallRoot(installRoot);
  const warnings = [];
  const assets = await buildAssets();

  await fs.rm(path.join(profile, "chrome", "svalinn"), {
    recursive: true,
    force: true,
  });
  const userJsPath = path.join(profile, "user.js");
  const userJs = (await readIfExists(userJsPath)) ?? "";
  if (userJs) {
    const cleaned = removeManagedUserJs(userJs);
    if (cleaned.trim()) await writeAtomic(userJsPath, cleaned);
    else await fs.rm(userJsPath, { force: true });
  }

  const cssPath = path.join(profile, "chrome", "userChrome.css");
  const css = (await readIfExists(cssPath)) ?? "";
  if (css.includes(CSS_START)) {
    const cleaned = removeManagedCss(css);
    if (cleaned.trim()) await writeAtomic(cssPath, cleaned);
    else await fs.rm(cssPath, { force: true });
  }

  const registryState = await readRegistry(installation.root);
  let reconciliation;
  if (registryState.state === "valid") {
    const remaining = await pruneRegistryProfiles(
      removeRegistryProfile(registryState.registry, profile)
    );
    reconciliation = await reconcileSharedState({
      installRoot: installation.root,
      registry: remaining,
      profiles: remaining.profiles,
      assets,
      warnings,
    });
  } else {
    if (registryState.state === "invalid") {
      warnings.push(
        `Shared registry is invalid (${registryState.error}); it was left untouched.`
      );
    }
    const shared = await inspectSharedBootstrap(installation.root);
    reconciliation = await reconcileSharedState({
      installRoot: installation.root,
      registry: null,
      profiles: [],
      assets,
      warnings,
      conservativeKeep: shared.managed || registryState.state === "invalid",
    });
  }

  return {
    status: "uninstalled",
    installRoot: installation.root,
    profile,
    profileContainer: target.container,
    remainingProfiles: reconciliation.remainingProfiles,
    sharedBootstrapRetained: reconciliation.sharedRetained,
    warnings,
  };
}

export async function rollback({
  backupDir,
  installRoot,
  profile: profileInput,
  __testFailAt = null,
}) {
  const target = await resolveProfileTarget(profileInput);
  const profile = target.profile;
  const installation = await inspectInstallRoot(installRoot);
  const warnings = [];

  const { manifest, operations } = await validateBackupManifest({
    backupDir,
    installRoot: installation.root,
    profile,
  });

  const shared = await inspectSharedBootstrap(installation.root);
  for (const record of manifest.files) {
    if (!isSharedRecord(record) || record.relative === REGISTRY_FILE) continue;
    if (shared.files[record.relative] === "foreign") {
      throw new InstallError(
        `Refusing to roll back: ${record.relative} was replaced by another tool ` +
          `and no longer belongs to Svalinn (${installation.root}).`
      );
    }
  }

  for (const operation of operations) {
    if (!operation.expectedSha256) continue;
    const current = await readIfExists(operation.target);
    if (current !== null && sha256(current) !== operation.expectedSha256) {
      warnings.push(
        `${operation.base}:${operation.relative} changed since Svalinn wrote it; ` +
          "the selected backup is being restored anyway."
      );
    }
  }

  const currentRegistryState = await readRegistry(installation.root);
  const assets = await buildAssets();

  const registryRecord = manifest.files.find(
    record => record.relative === REGISTRY_FILE && record.base === "install"
  );
  let backupRegistry = null;
  if (registryRecord?.existed) {
    const content = await readIfExists(
      path.join(backupDir, "install", REGISTRY_FILE)
    );
    if (content !== null) {
      try {
        backupRegistry = validateRegistry(
          JSON.parse(content),
          installation.root
        );
      } catch (error) {
        throw new InstallError(
          `Backup registry is not usable: ${error.message}`
        );
      }
    }
  }

  const restoreOperations = operations.filter(
    operation => !isSharedRecord(operation)
  );
  const sharedRestoreOperations = operations.filter(
    operation =>
      operation.base === "install" &&
      SHARED_FILES.includes(operation.relative)
  );
  for (const operation of restoreOperations) {
    if (__testFailAt === operation.relative) {
      const error = new Error(
        `Injected rollback failure for ${operation.relative}`
      );
      error.code = "ENOSPC";
      throw new InstallError(`Rollback failed: ${error.message}`);
    }
  }
  await applyRestore(restoreOperations);

  const baseRegistry =
    currentRegistryState.state === "valid"
      ? currentRegistryState.registry
      : backupRegistry;
  const retainedProfiles = (baseRegistry?.profiles ?? []).filter(
    entry => entry.path !== profile
  );
  const nextProfiles = (await profileHasLoader(profile))
    ? [...retainedProfiles, { id: profileId(profile), path: profile }]
    : retainedProfiles;

  const reconciliation = await reconcileSharedState({
    installRoot: installation.root,
    registry: baseRegistry,
    profiles: nextProfiles,
    assets,
    warnings,
    conservativeKeep:
      nextProfiles.length === 0 &&
      currentRegistryState.state === "invalid",
    restoreShared: sharedRestoreOperations,
  });

  return {
    status: "rolled-back",
    backupDir,
    profile: manifest.profile,
    installRoot: manifest.installRoot,
    remainingProfiles: reconciliation.remainingProfiles,
    sharedBootstrapRetained: reconciliation.sharedRetained,
    warnings,
  };
}

export async function status({ profile: profileInput, installRoot }) {
  const target = await resolveProfileTarget(profileInput);
  const profile = target.profile;
  const installation = await inspectInstallRoot(installRoot);
  const managed = await readManagedState(profile);
  const files = {
    bootloader:
      (await readIfExists(path.join(installation.root, "svalinn.cfg"))) !==
      null,
    autoconfigPref:
      (await readIfExists(
        path.join(
          installation.root,
          "defaults",
          "pref",
          "svalinn-autoconfig.js"
        )
      )) !== null,
    loader:
      (await readIfExists(
        path.join(profile, "chrome", "svalinn", "content", "loader.sys.mjs")
      )) !== null,
    adapter:
      (await readIfExists(
        path.join(profile, "chrome", "svalinn", "content", "adapter.js")
      )) !== null,
    css: (
      (await readIfExists(path.join(profile, "chrome", "userChrome.css"))) ?? ""
    ).includes(CSS_START),
  };
  const registryState = await readRegistry(installation.root);
  const shared = await inspectSharedBootstrap(installation.root);
  return {
    installed:
      Object.values(files).every(Boolean) &&
      managed.hasManagedBlock &&
      shared.managed,
    enabled: managed.enabled,
    installRoot: installation.root,
    zenVersion: installation.version,
    profile,
    profileContainer: target.container,
    dragBehavior: managed.dragBehavior,
    registered:
      registryState.state === "valid" &&
      registryState.registry.profiles.some(entry => entry.path === profile),
    registeredProfiles:
      registryState.state === "valid"
        ? registryState.registry.profiles.length
        : 0,
    sharedBootstrap: {
      present: shared.present,
      managed: shared.managed,
      foreign: shared.foreign,
    },
    files,
  };
}
