// Global wiring for Claude Code, Codex, Cursor and git clones. Every edited file is backed up first.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_DIR,
  CODEX_DIR,
  CURSOR_DIR,
  HOME,
  IS_WIN,
  STATE_DIR,
  backup,
  expandHome,
  fwd,
  isDir,
  nativePath,
  readJson,
  readText,
  samePath,
  which,
  writeIfChanged,
} from "./util.mjs";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = join(STATE_DIR, "app");
export const SHIM = join(STATE_DIR, "bin", "ai-memory-sync");
/** Windows: cmd.exe and PowerShell run this one (no .ps1, so no execution-policy prompts). */
export const SHIM_CMD = `${SHIM}.cmd`;
export const APP_CLI = join(APP_DIR, "bin", "ai-memory-sync.mjs");
const APP_RUN_SH = join(APP_DIR, "bin", "run.sh");
const SHIM_MARK = "ai-memory-sync shim (created by `ai-memory-sync install`)";
const STATE = join(STATE_DIR, "state.json");
const TEMPLATE_DIR = join(STATE_DIR, "git-template");
const MARKETPLACE = "ai-memory-sync";
const PLUGIN_ID = "ai-memory-sync@ai-memory-sync";
const GH_REPO = "leulfonseca/ai-memory-sync";
const SH_BEGIN = "# BEGIN ai-memory-sync";
const SH_END = "# END ai-memory-sync";
const MD_BEGIN = "<!-- BEGIN:ai-memory-sync -->";
const MD_END = "<!-- END:ai-memory-sync -->";

const q = (s) => (/[^A-Za-z0-9_./:-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
const isOurs = (cmd) => typeof cmd === "string" && cmd.includes("ai-memory-sync");

/**
 * Command string for Codex/Cursor hooks. POSIX: the sh shim. Windows: `node "<C:/.../ai-memory-sync.mjs>" ...`,
 * which parses the same in cmd.exe, PowerShell and Git Bash (forward slashes, one quoted path, bare `node`).
 */
export function hookCommand(args, win = IS_WIN, cli = APP_CLI) {
  return win ? `node "${fwd(cli)}" ${args}` : `${q(SHIM)} ${args}`;
}

/** argv prefix for Codex's `notify` (run without a shell). Windows: absolute node.exe + the CLI script. */
export function notifyPrefix(win = IS_WIN, node = process.execPath, cli = APP_CLI) {
  return win ? [node, cli] : [SHIM];
}

/** Our notify chain inside a parsed `notify` array: { orig } (the chained command) or null. */
function ourNotify(values) {
  const i = values.indexOf("codex-notify");
  if (i < 1 || !values.slice(0, i).some(isOurs)) return null;
  const dash = values.indexOf("--", i);
  return { prefix: values.slice(0, i), orig: dash >= 0 ? values.slice(dash + 1) : [] };
}

function cursorApp() {
  if (process.platform === "darwin") return existsSync("/Applications/Cursor.app") ? "/Applications/Cursor.app" : null;
  if (IS_WIN) {
    const exe = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe");
    return exe && existsSync(exe) ? exe : null;
  }
  return null;
}

export function detectTools() {
  return {
    claude: which("claude"),
    codex: which("codex") || (isDir(CODEX_DIR) ? CODEX_DIR : null),
    cursor: which("cursor") || cursorApp() || (isDir(CURSOR_DIR) ? CURSOR_DIR : null),
    git: which("git"),
  };
}

// ---------- tiny TOML helpers (top-level `notify` array only) ----------

function findTopLevelNotify(text) {
  const firstTable = text.search(/^\s*\[/m);
  const head = firstTable < 0 ? text : text.slice(0, firstTable);
  const m = head.match(/^notify\s*=\s*/m);
  if (!m) return null;
  const start = m.index;
  let i = start + m[0].length;
  if (text[i] !== "[") return null;
  const values = [];
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "]") return { start, end: i + 1, values };
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      values.push(JSON.parse(text.slice(i, j + 1)));
      i = j + 1;
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      values.push(text.slice(i + 1, j));
      i = j + 1;
    } else if (c === "#") {
      i = text.indexOf("\n", i);
      if (i < 0) return null;
    } else i++;
  }
  return null;
}

const tomlArray = (vals) => `notify = [${vals.map((v) => JSON.stringify(v)).join(", ")}]`;

export function notifyWithChain(text, prefix = notifyPrefix()) {
  const cur = findTopLevelNotify(text);
  const ours = cur && ourNotify(cur.values);
  const orig = ours ? ours.orig : cur ? cur.values : [];
  const line = tomlArray([...prefix, "codex-notify", "--", ...orig]);
  if (cur) return text.slice(0, cur.start) + line + text.slice(cur.end);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return `${line}${nl}${text}`;
}

export function notifyWithoutChain(text) {
  const cur = findTopLevelNotify(text);
  const ours = cur && ourNotify(cur.values);
  if (!ours) return text;
  if (ours.orig.length) return text.slice(0, cur.start) + tomlArray(ours.orig) + text.slice(cur.end);
  return text.slice(0, cur.start) + text.slice(cur.end).replace(/^\r?\n/, "");
}

// ---------- marker helpers ----------

function withMarked(text, begin, end, inner) {
  const t = text ?? "";
  const block = `${begin}\n${inner.trimEnd()}\n${end}`;
  const i = t.indexOf(begin);
  const j = t.indexOf(end);
  if (i >= 0 && j > i) return t.slice(0, i) + block + t.slice(j + end.length);
  return `${t.trimEnd()}${t.trim() ? "\n\n" : ""}${block}\n`;
}

function withoutMarked(text, begin, end) {
  if (text == null) return text;
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  if (i < 0 || j < i) return text;
  const r = `${text.slice(0, i).trimEnd()}\n${text.slice(j + end.length).replace(/^\n+/, "")}`.replace(/^\n+/, "");
  return r.trim() ? r.replace(/\n*$/, "\n") : "";
}

// ---------- JSON hook files (Codex ~/.codex/hooks.json, Cursor ~/.cursor/hooks.json) ----------

function addHooks(json, entries) {
  const out = json && typeof json === "object" ? structuredClone(json) : {};
  out.hooks ??= {};
  for (const [event, entry] of Object.entries(entries)) {
    const list = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = list.filter((e) => !isOurs(e.command) && !(e.hooks ?? []).some((h) => isOurs(h.command)));
    out.hooks[event] = [...kept, entry];
  }
  return out;
}

function removeHooks(json) {
  if (!json?.hooks) return json;
  const out = structuredClone(json);
  for (const [event, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e.command) && !(e.hooks ?? []).some((h) => isOurs(h.command)));
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  return out;
}

const CODEX_AGENTS = `## Project memory (ai-memory-sync)

Each project can keep shared AI memory in \`docs/ai-context/memory/\`. Save long-term notes about a project as \`.md\` files, one fact per file and never secrets, in \`docs/ai-context/memory/codex/\` at the project's root (create the folder if missing). The merged memory of every AI tool is the "Project memory" block in \`AGENTS.md\` (or \`AGENTS.override.md\` when the project uses local mode). It is rebuilt automatically after each turn, so do not edit the block by hand.`;

// Git for Windows runs hooks with its bundled sh, so the hook stays POSIX sh (LF endings) and calls
// run.sh, which finds node.exe. POSIX keeps calling the executable shim.
const POST_CHECKOUT = (win = IS_WIN) => {
  const test = win ? `[ -f ${q(fwd(APP_RUN_SH))} ]` : `[ -x ${q(SHIM)} ]`;
  const call = win ? `sh ${q(fwd(APP_RUN_SH))}` : q(SHIM);
  return `${SH_BEGIN} (scaffolds AI memory on the first checkout after a clone; skip with AI_MEMORY_SYNC=0)
case "$1" in *[!0]*) ;; *)
  if [ "\${AI_MEMORY_SYNC:-1}" != "0" ] && ${test}; then
    ${call} clone-hook "$(git rev-parse --show-toplevel)" || true
  fi ;;
esac
${SH_END}`;
};

// ---------- install ----------

const winArg = (a) => (/^[\w.:\\/@=-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

function run(cmd, args) {
  const opts = { encoding: "utf8", timeout: 180000, windowsHide: true };
  // Windows: npm-style .cmd shims (claude.cmd, codex.cmd) need cmd.exe; Node refuses to spawn them directly.
  const r =
    IS_WIN && /\.(cmd|bat)$/i.test(cmd)
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map(winArg).join(" ")}"`], {
          ...opts,
          windowsVerbatimArguments: true,
        })
      : spawnSync(cmd, args, opts);
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Value for `git config init.templateDir` read back as a native path. */
const gitPath = (v) => (v ? resolve(nativePath(expandHome(v))) : null);

function edit(file, transform, log, changes) {
  const before = readText(file);
  const after = transform(before);
  if (after == null || after === before) return false;
  const b = backup(file, log);
  writeIfChanged(file, after);
  changes.push({ file, backup: b, created: before == null });
  log(`${before == null ? "created" : "edited"}: ${file}`);
  return true;
}

export function installApp(log) {
  if (resolve(PLUGIN_ROOT) !== resolve(APP_DIR)) {
    rmSync(APP_DIR, { recursive: true, force: true });
    mkdirSync(APP_DIR, { recursive: true });
    for (const d of ["bin", "lib", "hooks", ".claude-plugin"]) {
      if (existsSync(join(PLUGIN_ROOT, d))) cpSync(join(PLUGIN_ROOT, d), join(APP_DIR, d), { recursive: true });
    }
    log(`app copied to ${APP_DIR}`);
  }
  for (const { path, content } of shimFiles()) {
    if (writeIfChanged(path, content)) log(`created: ${path}`);
    chmodSync(path, 0o755);
  }
}

/** Escape for a batch file: % must be doubled. */
const bat = (s) => s.replace(/%/g, "%%");

/** The shims: sh everywhere (Git Bash on Windows too), plus a .cmd for cmd.exe and PowerShell on Windows. */
export function shimFiles(win = IS_WIN, node = process.execPath) {
  const sh = `#!/bin/sh\n# ${SHIM_MARK}\nexec /bin/sh ${q(win ? fwd(APP_RUN_SH) : APP_RUN_SH)} "$@"\n`;
  const files = [{ path: SHIM, content: sh }];
  if (win) {
    const cmd = [
      "@echo off",
      `rem ${SHIM_MARK}`,
      "setlocal",
      `set "AMS_NODE=${bat(node)}"`,
      'if not exist "%AMS_NODE%" set "AMS_NODE=node"',
      `"%AMS_NODE%" "${bat(APP_CLI)}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    files.push({ path: SHIM_CMD, content: cmd });
  }
  return files;
}

const onPath = (dir) => (process.env.PATH || "").split(delimiter).some((d) => d && samePath(d.replace(/^"(.*)"$/, "$1"), dir));

export function install({ claudeSource = GH_REPO, log = console.log } = {}) {
  const tools = detectTools();
  const state = readJson(STATE, null) || { installedAt: new Date().toISOString(), changes: [], claude: {} };
  const changes = [];
  const missing = [];
  installApp(log);

  // PATH convenience link. Windows: symlinks need admin or developer mode, so copy the .cmd shim
  // (it holds absolute paths) into ~/.local/bin, where Claude Code's native installer puts claude.exe.
  const linkDir = join(HOME, ".local", "bin");
  const link = join(linkDir, IS_WIN ? "ai-memory-sync.cmd" : "ai-memory-sync");
  if (IS_WIN) {
    const cur = readText(link);
    if (isDir(linkDir) && (cur == null || cur.includes(SHIM_MARK))) {
      if (writeIfChanged(link, readText(SHIM_CMD))) log(`created: ${link}`);
      state.link = link;
    }
    if (!onPath(dirname(SHIM)) && !(state.link && onPath(linkDir))) {
      log(`PATH: add ${dirname(SHIM)} to your user PATH to run ai-memory-sync from any shell. PowerShell:`);
      log(`  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${dirname(SHIM)}', 'User')`);
    }
  } else if (isDir(linkDir) && !existsSync(link)) {
    try {
      symlinkSync(SHIM, link);
      state.link = link;
      log(`linked: ${link} -> ${SHIM}`);
    } catch {}
  }

  // Claude Code: plugin marketplace + plugin, user scope.
  if (tools.claude) {
    const known = readJson(join(CLAUDE_DIR, "plugins", "known_marketplaces.json"), {}) || {};
    const hadMarketplace = Boolean(known[MARKETPLACE]);
    for (const f of [join(CLAUDE_DIR, "settings.json")]) backup(f, log);
    let ok = true;
    if (!hadMarketplace) {
      const r = run(tools.claude, ["plugin", "marketplace", "add", claudeSource, "--scope", "user"]);
      ok = r.ok;
      if (!r.ok) log(`claude plugin marketplace add failed: ${r.out.split("\n").pop()}`);
      else state.claude.addedMarketplace = true;
    }
    if (ok && hadMarketplace) {
      // Re-run: refresh the marketplace clone so a newer plugin version is picked up.
      run(tools.claude, ["plugin", "marketplace", "update", MARKETPLACE]);
      const u = run(tools.claude, ["plugin", "update", PLUGIN_ID, "--scope", "user"]);
      if (u.ok) log(`claude: plugin ${PLUGIN_ID} up to date`);
    }
    if (ok) {
      const r = run(tools.claude, ["plugin", "install", PLUGIN_ID, "--scope", "user"]);
      if (r.ok) {
        state.claude.installedPlugin = true;
        log(`claude: installed plugin ${PLUGIN_ID} (user scope)`);
      } else {
        ok = false;
        log(`claude plugin install failed: ${r.out.split("\n").pop()}`);
      }
    }
    if (!ok) {
      // Fallback: register marketplace + enable plugin in ~/.claude/settings.json.
      edit(
        join(CLAUDE_DIR, "settings.json"),
        (t) => {
          const j = t ? JSON.parse(t) : {};
          j.extraKnownMarketplaces ??= {};
          j.extraKnownMarketplaces[MARKETPLACE] ??= { source: { source: "github", repo: GH_REPO } };
          j.enabledPlugins ??= {};
          j.enabledPlugins[PLUGIN_ID] = true;
          return `${JSON.stringify(j, null, 2)}\n`;
        },
        log,
        changes,
      );
      state.claude.settingsFallback = true;
    }
  } else missing.push("claude (Claude Code CLI not found)");

  // Codex: legacy notify (chained), stable hooks, global AGENTS.md note.
  if (tools.codex) {
    mkdirSync(CODEX_DIR, { recursive: true });
    edit(join(CODEX_DIR, "config.toml"), (t) => notifyWithChain(t ?? ""), log, changes);
    edit(
      join(CODEX_DIR, "hooks.json"),
      (t) => {
        const j = t ? JSON.parse(t) : {};
        const cmd = (ev) => ({ type: "command", command: hookCommand(`hook codex ${ev}`), timeout: 30 });
        return `${JSON.stringify(
          addHooks(j, {
            SessionStart: { matcher: "startup|resume|clear", hooks: [cmd("session-start")] },
            Stop: { hooks: [cmd("stop")] },
          }),
          null,
          2,
        )}\n`;
      },
      log,
      changes,
    );
    edit(join(CODEX_DIR, "AGENTS.md"), (t) => withMarked(t, MD_BEGIN, MD_END, CODEX_AGENTS), log, changes);
  } else missing.push("codex (no codex CLI and no ~/.codex)");

  // Cursor: user-level hooks.
  if (tools.cursor) {
    edit(
      join(CURSOR_DIR, "hooks.json"),
      (t) => {
        const j = t ? JSON.parse(t) : { version: 1 };
        j.version ??= 1;
        const cmd = (ev) => ({ command: hookCommand(`hook cursor ${ev}`), timeout: 30 });
        return `${JSON.stringify(addHooks(j, { sessionStart: cmd("sessionStart"), afterFileEdit: cmd("afterFileEdit"), stop: cmd("stop") }), null, 2)}\n`;
      },
      log,
      changes,
    );
  } else missing.push("cursor (no Cursor.app and no ~/.cursor)");

  // git clones: init.templateDir with a post-checkout hook.
  if (tools.git) {
    const cur = run("git", ["config", "--global", "--get", "init.templateDir"]);
    const existing = cur.ok && cur.out ? gitPath(cur.out) : null;
    const tdir = existing || TEMPLATE_DIR;
    const hook = join(tdir, "hooks", "post-checkout");
    edit(
      hook,
      (t) => {
        if (t == null) return `#!/bin/sh\n${POST_CHECKOUT()}\nexit 0\n`;
        // sh chokes on CR: hooks always get LF endings.
        const u = t.replace(/\r\n/g, "\n");
        const shebang = u.startsWith("#!") ? u.slice(0, u.indexOf("\n") + 1) : "";
        const rest = withoutMarked(u.slice(shebang.length), SH_BEGIN, SH_END) ?? "";
        return `${shebang || "#!/bin/sh\n"}${POST_CHECKOUT()}\n${rest}`;
      },
      log,
      changes,
    );
    chmodSync(hook, 0o755);
    if (!existing) {
      backup(join(HOME, ".gitconfig"), log);
      // Forward slashes on Windows: backslashes are escape characters in .gitconfig.
      execFileSync("git", ["config", "--global", "init.templateDir", IS_WIN ? fwd(tdir) : tdir], { windowsHide: true });
      state.gitTemplateDirSet = tdir;
      log(`git: set global init.templateDir = ${tdir}`);
    } else if (!samePath(existing, TEMPLATE_DIR)) log(`git: merged post-checkout into existing init.templateDir ${existing}`);
  } else missing.push("git");

  state.changes = [...(state.changes ?? []), ...changes];
  state.lastInstall = new Date().toISOString();
  writeIfChanged(STATE, `${JSON.stringify(state, null, 2)}\n`);
  return { tools, changes, missing };
}

// ---------- uninstall ----------

export function uninstall({ log = console.log } = {}) {
  const state = readJson(STATE, {}) || {};
  const tools = detectTools();
  const changes = [];
  if (tools.claude) {
    backup(join(CLAUDE_DIR, "settings.json"), log);
    const r = run(tools.claude, ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"]);
    log(r.ok ? `claude: uninstalled ${PLUGIN_ID}` : `claude: plugin not installed (${r.out.split("\n").pop()})`);
    if (state.claude?.addedMarketplace || !state.installedAt) {
      const m = run(tools.claude, ["plugin", "marketplace", "remove", MARKETPLACE, "--scope", "user"]);
      if (m.ok) log(`claude: removed marketplace ${MARKETPLACE}`);
    }
    edit(
      join(CLAUDE_DIR, "settings.json"),
      (t) => {
        if (!t) return null;
        const j = JSON.parse(t);
        let dirty = false;
        if (j.enabledPlugins?.[PLUGIN_ID] !== undefined) (delete j.enabledPlugins[PLUGIN_ID], (dirty = true));
        if (j.extraKnownMarketplaces?.[MARKETPLACE]) (delete j.extraKnownMarketplaces[MARKETPLACE], (dirty = true));
        return dirty ? `${JSON.stringify(j, null, 2)}\n` : null;
      },
      log,
      changes,
    );
  }
  const codexCfg = join(CODEX_DIR, "config.toml");
  if (existsSync(codexCfg)) edit(codexCfg, (t) => notifyWithoutChain(t), log, changes);
  for (const f of [join(CODEX_DIR, "hooks.json"), join(CURSOR_DIR, "hooks.json")]) {
    const t = readText(f);
    if (t == null) continue;
    const j = removeHooks(JSON.parse(t));
    const created = (state.changes ?? []).some((c) => c.file === f && c.created);
    if (created && Object.keys(j.hooks ?? {}).length === 0) {
      backup(f, log);
      unlinkSync(f);
      log(`removed: ${f} (created by install)`);
    } else edit(f, () => `${JSON.stringify(j, null, 2)}\n`, log, changes);
  }
  const codexAgents = join(CODEX_DIR, "AGENTS.md");
  if (existsSync(codexAgents)) {
    const created = (state.changes ?? []).some((c) => c.file === codexAgents && c.created);
    const n = withoutMarked(readText(codexAgents), MD_BEGIN, MD_END);
    if (n === "" && created) (backup(codexAgents, log), unlinkSync(codexAgents), log(`removed: ${codexAgents}`));
    else edit(codexAgents, () => n, log, changes);
  }
  // git template
  const cur = run("git", ["config", "--global", "--get", "init.templateDir"]);
  const tdir = cur.ok && cur.out ? gitPath(cur.out) : null;
  if (tdir && samePath(tdir, TEMPLATE_DIR)) {
    backup(join(HOME, ".gitconfig"), log);
    run("git", ["config", "--global", "--unset", "init.templateDir"]);
    log("git: unset global init.templateDir");
  } else if (tdir) {
    const hook = join(tdir, "hooks", "post-checkout");
    const t = readText(hook);
    if (t != null) {
      const n = withoutMarked(t, SH_BEGIN, SH_END);
      const created = (state.changes ?? []).some((c) => c.file === hook && c.created);
      if (created && /^#!\/bin\/sh\r?\n(exit 0\r?\n)?$/.test(n.trim() ? n.replace(/\n*$/, "\n") : "")) (backup(hook, log), unlinkSync(hook), log(`removed: ${hook}`));
      else edit(hook, () => n, log, changes);
    }
  }
  if (state.link) {
    try {
      const st = lstatSync(state.link);
      const linked = st.isSymbolicLink() && readlinkSync(state.link) === SHIM;
      const copied = st.isFile() && (readText(state.link) ?? "").includes(SHIM_MARK);
      if (linked || copied) (unlinkSync(state.link), log(`removed: ${state.link}`));
    } catch {}
  }
  for (const p of [APP_DIR, join(STATE_DIR, "bin"), TEMPLATE_DIR, STATE, join(STATE_DIR, "registry.json")]) {
    if (existsSync(p)) (rmSync(p, { recursive: true, force: true }), log(`removed: ${p}`));
  }
  try {
    rmdirSync(STATE_DIR); // only if empty
  } catch {}
  log("Project files (docs/ai-context, AGENTS.md blocks, local files) were left in place. Backups were kept.");
  return { changes };
}

// ---------- doctor (global part) ----------

export function doctorGlobal() {
  const tools = detectTools();
  const lines = [];
  const ok = (b) => (b ? "ok " : "-- ");
  lines.push(`node ${process.version}${Number(process.versions.node.split(".")[0]) >= 20 ? "" : " (needs >= 20)"}`);
  lines.push(`${ok(existsSync(SHIM))}shim ${SHIM}`);
  if (IS_WIN) {
    lines.push(`${ok(existsSync(SHIM_CMD))}shim ${SHIM_CMD}`);
    const node = which("node", { extra: false });
    lines.push(`${ok(node)}node on PATH${node ? ` (${node})` : ": Codex and Cursor hooks run \`node\`; add Node.js to PATH"}`);
    if (/[%$`]/.test(APP_CLI)) lines.push(`-- install path ${APP_CLI} has % $ or \`, which shells expand; set AI_MEMORY_SYNC_DIR to a plain path`);
  }
  const installed = readJson(join(CLAUDE_DIR, "plugins", "installed_plugins.json"), {}) || {};
  const claudePlugin = JSON.stringify(installed).includes(PLUGIN_ID);
  const settings = readJson(join(CLAUDE_DIR, "settings.json"), {}) || {};
  lines.push(
    tools.claude
      ? `${ok(claudePlugin || settings.enabledPlugins?.[PLUGIN_ID])}claude: plugin ${PLUGIN_ID} ${claudePlugin ? "installed" : settings.enabledPlugins?.[PLUGIN_ID] ? "enabled in settings.json" : "not installed"}`
      : "-- claude: not found",
  );
  if (tools.codex) {
    const cfg = readText(join(CODEX_DIR, "config.toml")) ?? "";
    const n = findTopLevelNotify(cfg);
    const ours = n && ourNotify(n.values);
    const exe = ours?.prefix[0];
    const exeOk = Boolean(exe) && existsSync(exe);
    lines.push(
      `${ok(ours && exeOk)}codex: notify chain${ours ? ` (chained: ${ours.orig.length ? "yes" : "none"})${exeOk ? "" : `; ${exe} not found, run install again`}` : " missing"}`,
    );
    lines.push(`${ok((readText(join(CODEX_DIR, "hooks.json")) ?? "").includes("ai-memory-sync"))}codex: ~/.codex/hooks.json (approve once in Codex with /hooks)`);
    lines.push(`${ok((readText(join(CODEX_DIR, "AGENTS.md")) ?? "").includes(MD_BEGIN))}codex: ~/.codex/AGENTS.md note`);
  } else lines.push("-- codex: not found");
  lines.push(tools.cursor ? `${ok((readText(join(CURSOR_DIR, "hooks.json")) ?? "").includes("ai-memory-sync"))}cursor: ~/.cursor/hooks.json` : "-- cursor: not found");
  const t = run("git", ["config", "--global", "--get", "init.templateDir"]);
  const tdir = t.ok && t.out ? gitPath(t.out) : null;
  lines.push(`${ok(tdir && (readText(join(tdir, "hooks", "post-checkout")) ?? "").includes(SH_BEGIN))}git: init.templateDir ${tdir ?? "(unset)"}`);
  return lines;
}
