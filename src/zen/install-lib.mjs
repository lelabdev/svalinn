/**
 * Persistent personal installation for Svalinn.
 *
 * A minimal autoconfig bootloader is installed into Zen's installation
 * directory. It registers a profile-local chrome manifest and loads the trusted
 * Svalinn loader at startup. No Marionette or remote debugging port is used.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadInjectionScript } from "./build.mjs";
import { inspectZenVersion } from "./version.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const persistentDir = path.join(here, "persistent");

export const USERJS_START = "// >>> Svalinn managed preferences >>>";
export const USERJS_END = "// <<< Svalinn managed preferences <<<";
export const CSS_START = "/* >>> Svalinn managed CSS >>> */";
export const CSS_END = "/* <<< Svalinn managed CSS <<< */";
export const DEFAULT_BACKUP_ROOT = (profile) =>
  path.join(profile, "svalinn-backup");

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
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

export async function inspectInstallRoot(root) {
  const resolved = path.resolve(root);
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

export async function findAutoconfigConflict(root) {
  const conflicts = [];
  for (const file of await listPrefFiles(root)) {
    if (path.basename(file) === "svalinn-autoconfig.js") continue;
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
  const block = [
    CSS_START,
    String(cssSource ?? "").trim(),
    CSS_END,
  ].join("\n");
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

async function backupFile(base, root, relative, backupDir, records) {
  const source = path.join(root, relative);
  const existing = await readIfExists(source);
  records.push({ base, relative, existed: existing !== null });
  if (existing === null) return;
  const target = path.join(backupDir, base, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, existing);
}

async function writeAsset(root, relative, content) {
  await writeAtomic(path.join(root, relative), content);
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
        { loader: "0.1.0", installedAt: new Date().toISOString() },
        null,
        2
      )}\n`,
    },
    css: await readIfExists(path.resolve(here, "../../userChrome.css")),
  };
}

/**
 * Install or update Svalinn in a Zen installation and profile.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function install({
  profile,
  installRoot,
  backupRoot = null,
  enabled = true,
  dragBehavior = "block",
  allowUnverifiedVersion = false,
  force = false,
}) {
  if (!profile) throw new InstallError("A profile directory is required");
  profile = path.resolve(profile);

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

  await fs.mkdir(profile, { recursive: true });
  const assets = await buildAssets();
  if (!assets.css) {
    throw new InstallError("Missing userChrome.css source in the repository");
  }
  const timestamp = `${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = path.join(
    backupRoot ?? DEFAULT_BACKUP_ROOT(profile),
    timestamp
  );
  await fs.mkdir(backupDir, { recursive: true });

  const records = [];
  for (const [relative, content] of Object.entries(assets.install)) {
    await backupFile("install", installation.root, relative, backupDir, records);
    await writeAsset(installation.root, relative, content);
  }

  for (const [relative, content] of Object.entries(assets.profile)) {
    await backupFile("profile", profile, relative, backupDir, records);
    await writeAsset(profile, relative, content);
  }

  const cssPath = path.join(profile, "chrome", "userChrome.css");
  await backupFile("profile", profile, "chrome/userChrome.css", backupDir, records);
  const existingCss = (await readIfExists(cssPath)) ?? "";
  await writeAtomic(cssPath, mergeManagedCss(existingCss, assets.css));

  const userJsPath = path.join(profile, "user.js");
  const userJs = (await readIfExists(userJsPath)) ?? "";
  records.push({
    base: "profile",
    relative: "user.js",
    existed: userJs !== "",
  });
  if (userJs) {
    const target = path.join(backupDir, "profile", "user.js");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, userJs);
  }
  await writeAtomic(
    userJsPath,
    mergeManagedUserJs(userJs, { enabled, dragBehavior })
  );

  await fs.writeFile(
    path.join(backupDir, "backup.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        installRoot: installation.root,
        profile,
        version: installation.version,
        files: records,
      },
      null,
      2
    )}\n`
  );

  return {
    status: "installed",
    installRoot: installation.root,
    binary: installation.binary,
    zenVersion: installation.version,
    profile,
    backupDir,
    files: [
      ...Object.keys(assets.install),
      ...Object.keys(assets.profile),
      "chrome/userChrome.css",
      "user.js",
    ],
  };
}

export async function uninstall({ profile, installRoot }) {
  profile = path.resolve(profile);
  const installation = await inspectInstallRoot(installRoot);

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

  for (const relative of [
    "svalinn.cfg",
    "defaults/pref/svalinn-autoconfig.js",
  ]) {
    await fs.rm(path.join(installation.root, relative), { force: true });
  }

  return {
    status: "uninstalled",
    installRoot: installation.root,
    profile,
  };
}

export async function rollback({ backupDir, installRoot, profile }) {
  const manifestPath = path.join(backupDir, "backup.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const record of manifest.files ?? []) {
    const root = record.base === "install" ? installRoot : profile;
    const target = path.join(root, record.relative);
    if (record.existed) {
      const source = path.join(backupDir, record.base, record.relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    } else {
      await fs.rm(target, { force: true });
      await pruneEmptyParents(target, root);
    }
  }
  return {
    status: "rolled-back",
    backupDir,
    profile: manifest.profile,
    installRoot: manifest.installRoot,
  };
}

export async function status({ profile, installRoot }) {
  const installation = await inspectInstallRoot(installRoot);
  const managed = await readManagedState(profile);
  const files = {
    bootloader: (await readIfExists(path.join(installation.root, "svalinn.cfg"))) !== null,
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
    css:
      (
        (await readIfExists(
          path.join(profile, "chrome", "userChrome.css")
        )) ?? ""
      ).includes(CSS_START),
  };
  return {
    installed: Object.values(files).every(Boolean) && managed.hasManagedBlock,
    enabled: managed.enabled,
    installRoot: installation.root,
    zenVersion: installation.version,
    profile: path.resolve(profile),
    dragBehavior: managed.dragBehavior,
    files,
  };
}
