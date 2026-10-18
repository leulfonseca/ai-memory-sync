import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const HOME = process.env.AI_MEMORY_SYNC_HOME_OVERRIDE || homedir();
export const STATE_DIR = process.env.AI_MEMORY_SYNC_DIR || join(HOME, ".ai-memory-sync");
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || join(HOME, ".codex");
export const CURSOR_DIR = join(HOME, ".cursor");
export const REPO_URL = "https://github.com/leulfonseca/ai-memory-sync";

export const expandHome = (p) => (p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

export function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function readJson(p, fallback = null) {
  const t = readText(p);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

/** Write only when content changed. Atomic (tmp + rename). Returns true if written. */
export function writeIfChanged(p, content) {
  if (readText(p) === content) return false;
  mkdirSync(dirname(p), { recursive: true });
  let target = p;
  try {
    if (lstatSync(p).isSymbolicLink()) target = resolve(dirname(p), execFileSync("readlink", [p]).toString().trim());
  } catch {}
  const tmp = `${target}.tmp-ams-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
  return true;
}

export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

/** Copy `file` to `<file>.bak-ai-memory-sync-<timestamp>`; returns the backup path (or null if no file). */
export function backup(file, log) {
  if (!existsSync(file)) return null;
  const b = `${file}.bak-ai-memory-sync-${timestamp()}`;
  copyFileSync(file, b);
  log?.(`backup: ${b}`);
  return b;
}

export function git(root, args, { allowFail = true } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    if (!allowFail) throw e;
    return null;
  }
}

/** Walk up from `start` to the directory containing `.git` (dir or file). */
export function gitRoot(start) {
  let d = resolve(start || ".");
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Claude Code's project slug: every non-alphanumeric character of the absolute path becomes "-". */
export const claudeSlug = (absPath) => resolve(absPath).replace(/[^A-Za-z0-9]/g, "-");
export const claudeMemoryDir = (absPath) => join(CLAUDE_DIR, "projects", claudeSlug(absPath), "memory");

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders"].map((p) => resolve(p));

/** Hooks never scaffold $HOME itself or temp dirs. */
export function hookAllowed(root) {
  if (!root || process.env.AI_MEMORY_SYNC === "0") return false;
  const r = resolve(root);
  if (r === resolve(HOME) || r === sep) return false;
  if (process.env.AI_MEMORY_SYNC_ALLOW_TMP === "1") return true; // tests only
  return !TMP_ROOTS.some((t) => r === t || r.startsWith(t + sep));
}

export function which(cmd) {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".local/bin")];
  for (const d of [...(process.env.PATH || "").split(":"), ...extra]) {
    if (d && existsSync(join(d, cmd))) return join(d, cmd);
  }
  return null;
}

export function readStdin(timeoutMs = 2000) {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    let data = "";
    const t = setTimeout(() => res(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => (clearTimeout(t), res(data)));
    process.stdin.on("error", () => (clearTimeout(t), res(data)));
  });
}
