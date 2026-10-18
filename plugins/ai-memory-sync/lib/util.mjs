import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { delimiter, dirname, join, resolve, sep } from "node:path";

export const IS_WIN = process.platform === "win32";
const pathFor = (win) => (win ? path.win32 : path.posix);

export const HOME = process.env.AI_MEMORY_SYNC_HOME_OVERRIDE || homedir();
export const STATE_DIR = process.env.AI_MEMORY_SYNC_DIR || join(HOME, ".ai-memory-sync");
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || join(HOME, ".codex");
export const CURSOR_DIR = join(HOME, ".cursor");
export const REPO_URL = "https://github.com/leulfonseca/ai-memory-sync";

export const expandHome = (p) => (p === "~" ? HOME : p.startsWith("~/") || (IS_WIN && p.startsWith("~\\")) ? join(HOME, p.slice(2)) : p);

/** Forward slashes: safe inside double quotes in cmd, PowerShell and sh, and accepted by node and git on Windows. */
export const fwd = (p) => String(p).replace(/\\/g, "/");

/**
 * Windows only: turn the path spellings other tools hand us (Git Bash `/c/x`, `/cygdrive/c/x`,
 * URI-style `/c:/x`, lower-case drive letters) into a native `C:\x` path. Identity elsewhere.
 */
export function nativePath(p, win = IS_WIN) {
  if (!win || typeof p !== "string" || !p) return p;
  let s = p;
  const m = s.match(/^\/(?:cygdrive\/)?([A-Za-z])(?::)?(?=[\\/]|$)(.*)$/);
  if (m) s = `${m[1]}:${m[2] || "\\"}`;
  if (/^[A-Za-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return path.win32.normalize(s);
}

/** Path equality: case-insensitive on Windows (NTFS), exact elsewhere. */
export function samePath(a, b, win = IS_WIN) {
  if (a == null || b == null) return false;
  const P = pathFor(win);
  const n = (x) => (win ? P.resolve(nativePath(x, true)).toLowerCase() : P.resolve(x));
  return n(a) === n(b);
}

/** `child` is `parent` or inside it. */
export function isInside(child, parent, win = IS_WIN) {
  const P = pathFor(win);
  const n = (x) => (win ? P.resolve(nativePath(x, true)).toLowerCase() : P.resolve(x));
  const c = n(child);
  const p = n(parent).replace(/[\\/]+$/, "");
  return c === p || c.startsWith(p + P.sep);
}

/** Stable key for path-indexed maps (the registry): unchanged on POSIX, normalised on Windows. */
export const pathKey = (p, win = IS_WIN) => (win ? pathFor(true).resolve(nativePath(p, true)).toLowerCase() : p);

/** realpath that also expands Windows 8.3 short names (C:\Users\RUNNER~1). Falls back to resolve(). */
export function realPath(p) {
  try {
    return IS_WIN ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Use the line endings of `original` (CRLF when it has any) for `next`. */
export function withEol(original, next) {
  if (next == null || original == null || !original.includes("\r\n")) return next;
  return next.replace(/\r?\n/g, "\r\n");
}
export const lf = (t) => (t == null ? t : t.replace(/\r\n/g, "\n"));

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
};

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
    if (lstatSync(p).isSymbolicLink()) target = resolve(dirname(p), readlinkSync(p));
  } catch {}
  const tmp = `${target}.tmp-ams-${process.pid}`;
  writeFileSync(tmp, content);
  // Windows: rename over a file another process holds open (editor, indexer, antivirus) fails
  // with EPERM/EBUSY/EACCES for a moment. Retry, then fall back to a plain overwrite.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, target);
      return true;
    } catch (e) {
      if (!IS_WIN || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      if (i >= 5) break;
      sleepSync(20 * (i + 1));
    }
  }
  try {
    writeFileSync(target, content);
  } finally {
    rmSync(tmp, { force: true });
  }
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

/** Java-style 32-bit string hash, as Claude Code uses for over-long project slugs. */
function hash32(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
const SLUG_MAX = 200;

/**
 * Claude Code's project folder name under ~/.claude/projects: every non-alphanumeric character of
 * the absolute path becomes "-" (`/Users/me/app` -> `-Users-me-app`, `C:\Users\me\app` -> `C--Users-me-app`).
 * Names over 200 characters are cut and get a base-36 hash of the full path appended.
 */
export function claudeSlug(absPath, win = IS_WIN) {
  const abs = pathFor(win).resolve(win ? nativePath(absPath, true) : absPath).normalize("NFC");
  const slug = abs.replace(/[^A-Za-z0-9]/g, "-");
  return slug.length <= SLUG_MAX ? slug : `${slug.slice(0, SLUG_MAX)}-${Math.abs(hash32(abs)).toString(36)}`;
}

/** Long Windows paths: the hash depends on the separator Claude saw, so both spellings are candidates. */
export function claudeSlugs(absPath, win = IS_WIN) {
  const a = claudeSlug(absPath, win);
  if (!win || a.length <= SLUG_MAX) return [a];
  const abs = pathFor(true).resolve(nativePath(absPath, true)).normalize("NFC");
  const b = `${a.slice(0, SLUG_MAX)}-${Math.abs(hash32(fwd(abs))).toString(36)}`;
  return a === b ? [a] : [a, b];
}

export const claudeMemoryDir = (absPath) => join(CLAUDE_DIR, "projects", claudeSlug(absPath), "memory");
export const claudeMemoryDirs = (absPath) => claudeSlugs(absPath).map((s) => join(CLAUDE_DIR, "projects", s, "memory"));

/** `<...>/.claude/projects/<slug>/memory` for a file inside a Claude memory folder (any separator), else null. */
export function claudeMemoryDirOf(file, win = IS_WIN) {
  if (!file) return null;
  const P = pathFor(win);
  const f = win ? nativePath(String(file), true) : String(file);
  const m = f.match(/^(.*[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory)(?:[\\/]|$)/);
  if (m) return win ? P.resolve(m[1]) : m[1];
  const projects = P.join(CLAUDE_DIR, "projects");
  if (!isInside(f, projects, win) || samePath(f, projects, win)) return null;
  const parts = P.relative(P.resolve(projects), P.resolve(f)).split(/[\\/]/);
  return parts.length >= 2 && parts[1] === "memory" ? P.join(projects, parts[0], "memory") : null;
}

const TMP_ROOTS = [
  ...new Set(
    [
      tmpdir(),
      realPath(tmpdir()),
      ...(IS_WIN
        ? [process.env.TEMP, process.env.TMP, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Temp")]
        : ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]),
    ]
      .filter(Boolean)
      .map((p) => resolve(p)),
  ),
];

/** Hooks never scaffold $HOME itself, a drive or filesystem root, or temp dirs. */
export function hookAllowed(root) {
  if (!root || process.env.AI_MEMORY_SYNC === "0") return false;
  const r = resolve(root);
  if (samePath(r, HOME) || dirname(r) === r || r === sep) return false;
  if (process.env.AI_MEMORY_SYNC_ALLOW_TMP === "1") return true; // tests only
  return !TMP_ROOTS.some((t) => isInside(r, t));
}

/** Directories searched after PATH: GUI apps and hooks often run with a minimal PATH. */
function extraBinDirs() {
  if (!IS_WIN) return ["/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".local/bin")];
  const { APPDATA, LOCALAPPDATA, ProgramFiles } = process.env;
  return [
    join(HOME, ".local", "bin"),
    APPDATA && join(APPDATA, "npm"),
    LOCALAPPDATA && join(LOCALAPPDATA, "Programs", "cursor", "resources", "app", "bin"),
    ProgramFiles && join(ProgramFiles, "nodejs"),
    ProgramFiles && join(ProgramFiles, "Git", "cmd"),
  ].filter(Boolean);
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Find an executable on PATH (plus common install dirs). On Windows it honours PATHEXT (.exe, .cmd, ...). */
export function which(cmd, { extra = true } = {}) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const d of [...(process.env.PATH || "").split(delimiter), ...(extra ? extraBinDirs() : [])]) {
    if (!d) continue;
    for (const e of exts) {
      const p = join(d.replace(/^"(.*)"$/, "$1"), cmd + e);
      if (isFile(p)) return p;
    }
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
