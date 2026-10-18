#!/usr/bin/env node
// ai-memory-sync: keep AI coding-assistant memories inside each project, readable by Claude Code, Codex and Cursor.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { doctorGlobal, install, uninstall } from "../lib/install.mjs";
import {
  CTX,
  LOCAL_FILES,
  MDC,
  MEM,
  init,
  plan,
  readConfig,
  reposForMemoryDir,
  resolveMode,
  setGitConfigMode,
  sources,
  switchMode,
  sync,
} from "../lib/project.mjs";
import {
  HOME,
  IS_WIN,
  claudeMemoryDir,
  claudeMemoryDirOf,
  claudeMemoryDirs,
  expandHome,
  fwd,
  git,
  gitRoot,
  hookAllowed,
  isDir,
  nativePath,
  readStdin,
  readText,
  samePath,
} from "../lib/util.mjs";

const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json"), "utf8")).version;

const HELP = `ai-memory-sync ${VERSION}

Usage:
  ai-memory-sync init [path]                 scaffold docs/ai-context and the generated files (idempotent)
  ai-memory-sync sync [path]                 copy tool memories in, scrub, rebuild the memory block
  ai-memory-sync mode [local|git|off] [path] show or switch the project's mode (git asks to confirm)
        --yes                                skip the confirmation prompt
        --force                              allow git mode on a public (or unknown) remote
  ai-memory-sync scan [--root ~/Developer] [--apply] [--all] [--depth 5]
                                             find git repos that use AI memory; --apply sets them up
  ai-memory-sync install                     wire Claude Code, Codex, Cursor and git clones (backs up edits)
  ai-memory-sync uninstall                   undo install (backups are kept)
  ai-memory-sync doctor [path]               report global wiring and the project's state

Modes: local (default; memory stays out of git), git (memory committed with the project), off.
Set AI_MEMORY_SYNC=0 to disable every hook for one command or session.`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !["--root", "--depth", "--source"].includes(argv[i - 1]));

const redactionSummary = (counts) => {
  const parts = Object.entries(counts).map(([k, n]) => `${k}×${n}`);
  return parts.length ? `; redacted ${parts.join(", ")}` : "";
};

function projectRoot(p) {
  const abs = resolve(nativePath(p ?? "."));
  return gitRoot(abs) ?? abs;
}

function printResult(r, verb) {
  if (r.mode === "off") return console.log(`ai-memory-sync: ${r.root} is off; nothing to do.`);
  const changed = r.changed.length ? `; changed ${r.changed.length}: ${r.changed.join(", ")}` : "; no changes";
  console.log(`ai-memory-sync ${verb}: ${r.root} [${r.mode}]${r.notes != null ? ` ${r.notes} notes` : ""}${changed}${redactionSummary(r.counts ?? {})}`);
  for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
}

// ---------- public remote detection ----------

function githubRepos(root) {
  const out = git(root, ["remote", "-v"]) ?? "";
  const urls = [...new Set(out.split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean))];
  return urls.map((u) => {
    const m = u.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
    return { url: u, repo: m ? `${m[1]}/${m[2]}` : null };
  });
}

/** Returns "none" | "private" | "public" | "unknown" (unknown is treated as public). */
export async function remoteVisibility(root) {
  const remotes = githubRepos(root);
  if (!remotes.length) return { visibility: "none", detail: [] };
  const detail = [];
  for (const r of remotes) {
    if (!r.repo) {
      detail.push({ ...r, visibility: "unknown" });
      continue;
    }
    let v = null;
    try {
      const { execFileSync } = await import("node:child_process");
      v = execFileSync("gh", ["repo", "view", r.repo, "--json", "visibility", "-q", ".visibility"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15000,
      })
        .trim()
        .toLowerCase();
    } catch {}
    if (!v) {
      try {
        const res = await fetch(`https://api.github.com/repos/${r.repo}`, { headers: { "User-Agent": "ai-memory-sync" } });
        if (res.status === 200) v = (await res.json()).private ? "private" : "public";
      } catch {}
    }
    detail.push({ ...r, visibility: v || "unknown" });
  }
  const vs = detail.map((d) => d.visibility);
  const visibility = vs.includes("public") ? "public" : vs.includes("unknown") ? "unknown" : "private";
  return { visibility, detail };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function cmdMode() {
  const [, m, p] = positional;
  if (!m || !["local", "git", "off"].includes(m)) {
    const root = projectRoot(m && !["local", "git", "off"].includes(m) ? m : p);
    const r = resolveMode(root);
    console.log(`${root}: ${r.mode} (${r.source})`);
    return;
  }
  const root = projectRoot(p);
  if (m === "git") {
    const vis = await remoteVisibility(root);
    if ((vis.visibility === "public" || vis.visibility === "unknown") && !flags.has("--force")) {
      const why = vis.detail.map((d) => `${d.url} (${d.visibility})`).join(", ");
      console.error(`Refusing git mode: a remote is ${vis.visibility === "public" ? "public" : "of unknown visibility, treated as public"}: ${why}.`);
      console.error("Committed memories would be published. Use --force only if that is intended.");
      process.exitCode = 1;
      return;
    }
    if (!flags.has("--yes")) {
      const ok = await confirm(
        `Git mode commits AI memory (docs/ai-context, the AGENTS.md block) with ${root}. Remote visibility: ${vis.visibility}. Continue?`,
      );
      if (!ok) {
        console.error("Aborted (pass --yes to skip the prompt).");
        process.exitCode = 1;
        return;
      }
    }
  }
  const r = switchMode(root, m, (s) => console.log(`  ${s}`));
  console.log(`ai-memory-sync: ${root} mode ${r.from} -> ${r.to}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}

// ---------- scan ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".next", "target", "Library", ".Trash", "AppData"]);

function findRepos(root, depth) {
  const out = [];
  const walk = (d, lvl) => {
    if (existsSync(join(d, ".git"))) {
      out.push(d);
      return;
    }
    if (lvl >= depth) return;
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(join(d, e.name), lvl + 1);
    }
  };
  walk(resolve(root), 0);
  return out.sort();
}

const hasMd = (d) => {
  try {
    return readdirSync(d).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
};

function cmdScan() {
  const root = resolve(nativePath(expandHome(opt("--root", join(HOME, "Developer")))));
  const depth = Number(opt("--depth", 5));
  const apply = flags.has("--apply");
  const all = flags.has("--all");
  const repos = findRepos(root, depth);
  const touched = [];
  console.log(`Scanning ${root} (depth ${depth}): ${repos.length} git repos`);
  for (const r of repos) {
    const claude = sources(r).claude.some(hasMd);
    const ctx = isDir(join(r, CTX));
    const { mode, source } = resolveMode(r);
    let hint = "";
    if (!claude) {
      // Sessions started in a parent folder store memory under the parent's slug.
      for (let d = dirname(r); d !== dirname(d) && d.startsWith(root); d = dirname(d)) {
        if (hasMd(claudeMemoryDir(d))) {
          hint = ` (parent ${d} has Claude memory; add it to .ai-memory-sync.json claudeMemoryDirs)`;
          break;
        }
      }
    }
    const marked = claude || ctx;
    const tag = `${marked ? "*" : " "} ${r}  claude-memory:${claude ? "yes" : "no"} docs/ai-context:${ctx ? "yes" : "no"} mode:${mode} (${source})${hint}`;
    console.log(tag);
    if (!apply || (!marked && !all) || mode === "off") continue;
    if (source === "default") setGitConfigMode(r, "local");
    init(r);
    const s = sync(r);
    touched.push(r);
    printResult(s, "sync");
  }
  if (apply) console.log(`Applied to ${touched.length} repos.`);
  else console.log("* = uses AI memory. Run with --apply to set those up (local mode unless already in git mode).");
}

// ---------- doctor ----------

function cmdDoctor(p) {
  console.log("Global:");
  for (const l of doctorGlobal()) console.log(`  ${l}`);
  const root = projectRoot(p);
  const { mode, source } = resolveMode(root);
  console.log(`Project ${root}:`);
  console.log(`  mode: ${mode} (${source})`);
  if (mode === "off") return;
  const src = sources(root);
  for (const d of src.claude) console.log(`  claude source: ${d} ${existsSync(d) ? "(exists)" : "(missing)"}`);
  for (const d of [...src.codex, ...src.cursor]) console.log(`  extra source: ${d} ${existsSync(d) ? "(exists)" : "(missing)"}`);
  console.log(`  scaffold: ${isDir(join(root, MEM)) ? "present" : "missing (run init)"}`);
  const pl = plan(root, mode);
  const stale = pl.files.filter((f) => f.content != null && readText(f.path) !== f.content).map((f) => f.path);
  console.log(`  notes: ${pl.notes}; generated files ${stale.length ? `out of date: ${stale.join(", ")} (run sync)` : "up to date"}`);
  for (const w of pl.warnings) console.log(`  warning: ${w}`);
  if (mode === "local") {
    const leaked = [CTX, MDC, ...LOCAL_FILES].filter((f) => git(root, ["ls-files", "--", f]));
    if (leaked.length) console.log(`  warning: tracked by git despite local mode: ${leaked.join(", ")}`);
    const ov = readText(join(root, "AGENTS.override.md"));
    if (ov && Buffer.byteLength(ov) > 32768) console.log("  warning: AGENTS.override.md exceeds Codex's 32 KiB project_doc_max_bytes default");
  }
  if (readConfig(root).copy.length) console.log(`  extra copies: ${readConfig(root).copy.map((c) => `${c.from} -> ${c.to}`).join(", ")}`);
}

// ---------- hooks ----------

function syncQuiet(root, withInit) {
  try {
    if (!hookAllowed(root)) return null;
    if (withInit) init(root);
    return sync(root);
  } catch (e) {
    if (process.env.AI_MEMORY_SYNC_DEBUG) console.error(e);
    return null;
  }
}

function targetsFor(cwd) {
  const set = new Set();
  const root = gitRoot(cwd);
  if (root) set.add(root);
  for (const d of claudeMemoryDirs(cwd)) for (const r of reposForMemoryDir(d)) set.add(r);
  return { root, set };
}

async function cmdHook(tool, event) {
  if (process.env.AI_MEMORY_SYNC === "0") return;
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {}
  if (tool === "claude" || tool === "codex") {
    const cwd = nativePath(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (event === "post-tool-use") {
      const fp = input.tool_input?.file_path || input.tool_response?.filePath || "";
      const memDir = claudeMemoryDirOf(fp);
      if (!memDir) return;
      const set = new Set(reposForMemoryDir(memDir));
      const root = gitRoot(cwd);
      if (root && sources(root).claude.some((d) => samePath(d, memDir))) set.add(root);
      for (const r of set) syncQuiet(r, false);
      return;
    }
    const { root, set } = targetsFor(cwd);
    for (const r of set) syncQuiet(r, event === "session-start" && r === root);
    return; // stdout stays empty: SessionStart stdout would be injected into context
  }
  if (tool === "cursor") {
    const roots = (input.workspace_roots?.length ? input.workspace_roots : [process.cwd()]).map((r) => resolve(nativePath(String(r))));
    const contexts = [];
    for (const wr of roots) {
      if (event === "afterFileEdit" && !fwd(input.file_path ?? "").includes(`/${MEM}/`)) continue;
      const { root, set } = targetsFor(wr);
      for (const r of set) {
        const res = syncQuiet(r, event === "sessionStart" && r === root);
        if (event === "sessionStart" && res?.mode === "local") {
          const doc = readText(join(r, "AGENTS.local.md"));
          if (doc) contexts.push(doc);
        }
      }
    }
    if (event === "sessionStart") process.stdout.write(JSON.stringify(contexts.length ? { additional_context: contexts.join("\n\n").slice(0, 30000) } : {}));
    else if (event === "stop") process.stdout.write("{}");
  }
}

/** Quote one argument for a cmd.exe command line. */
const winArg = (a) => (/^[\w.:\\/=-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

/** Codex legacy notify: argv = codex-notify -- <original notify argv...> <payload JSON>. */
function cmdCodexNotify() {
  const rest = argv.slice(argv.indexOf("codex-notify") + 1);
  const payloadArg = rest[rest.length - 1];
  let payload = null;
  try {
    payload = JSON.parse(payloadArg);
  } catch {}
  const dash = rest.indexOf("--");
  const orig = rest.slice(dash >= 0 ? dash + 1 : 0, payload ? -1 : undefined);
  if (orig.length) {
    try {
      const args = [...orig.slice(1), ...(payload ? [payloadArg] : [])];
      const opts = { detached: true, stdio: "ignore", windowsHide: true };
      // Windows: .cmd/.bat cannot be spawned without a shell (Node refuses since the 2024 batch-file fix).
      const child =
        IS_WIN && /\.(cmd|bat)$/i.test(orig[0])
          ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[orig[0], ...args].map(winArg).join(" ")}"`], {
              ...opts,
              windowsVerbatimArguments: true,
            })
          : spawn(orig[0], args, opts);
      child.on("error", () => {});
      child.unref();
    } catch {}
  }
  if (process.env.AI_MEMORY_SYNC === "0" || !payload?.cwd) return;
  for (const r of targetsFor(nativePath(payload.cwd)).set) syncQuiet(r, true);
}

/** git post-checkout after a clone: local mode only, so no tracked file changes. */
function cmdCloneHook(p) {
  if (process.env.AI_MEMORY_SYNC === "0") return;
  const root = projectRoot(p);
  try {
    const { mode } = resolveMode(root);
    if (mode !== "local" || !hookAllowed(root)) return;
    setGitConfigMode(root, "local");
    init(root, { mode: "local" });
    sync(root);
    console.log("ai-memory-sync: local mode (memories stay out of git). Run `ai-memory-sync mode git` to version them.");
  } catch {}
}

// ---------- main ----------

async function main() {
  const [cmd, a1, a2] = positional;
  switch (cmd) {
    case "init":
      return printResult(init(projectRoot(a1)), "init");
    case "sync":
      return printResult(sync(projectRoot(a1)), "sync");
    case "mode":
      return cmdMode();
    case "scan":
      return cmdScan();
    case "install": {
      const r = install({ claudeSource: opt("--source", undefined) });
      if (r.missing.length) console.log(`Not wired (not installed): ${r.missing.join("; ")}`);
      console.log("Done. Run `ai-memory-sync doctor` to check. Codex asks once to approve the new hooks (/hooks).");
      return;
    }
    case "uninstall":
      return void uninstall();
    case "doctor":
      return cmdDoctor(a1);
    case "hook":
      return cmdHook(a1, a2);
    case "codex-notify":
      return cmdCodexNotify();
    case "clone-hook":
      return cmdCloneHook(a1);
    case "version":
      return console.log(VERSION);
    default:
      if (flags.has("--version")) return console.log(VERSION);
      console.log(HELP);
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  const quiet = ["hook", "codex-notify", "clone-hook"].includes(positional[0]);
  if (!quiet) {
    console.error(`ai-memory-sync: ${e.message}`);
    process.exitCode = 1;
  }
});
