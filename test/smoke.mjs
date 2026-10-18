// End-to-end smoke test: install, doctor, every hook command as the tools would run it, a git clone
// through the template hook, uninstall. Runs in a throwaway HOME/USERPROFILE with fake Claude, Codex
// and Cursor config dirs and a stub `claude` CLI, so it never touches the real machine's config.
// Run: node test/smoke.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(REPO, "plugins", "ai-memory-sync");
const CLI = join(PLUGIN, "bin", "ai-memory-sync.mjs");
const VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;
const fwd = (p) => p.replace(/\\/g, "/");

const sandbox = mkdtempSync(join(realpathSync.native(tmpdir()), "ams-smoke-"));
const home = join(sandbox, "home");
const fakeBin = join(sandbox, "bin");
for (const d of [".claude", ".codex", ".cursor", ".local/bin", "AppData/Roaming", "AppData/Local"]) mkdirSync(join(home, d), { recursive: true });
mkdirSync(fakeBin, { recursive: true });

// Stub `claude` CLI: records its argv and fakes `plugin install` the way doctor checks it.
const claudeLog = join(sandbox, "claude-calls.log");
writeFileSync(
  join(fakeBin, "claude-stub.mjs"),
  `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(claudeLog)}, args.join(" ") + "\\n");
if (args[0] === "plugin" && args[1] === "install") {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ plugins: { [args[2]]: [{ scope: "user" }] } }));
}
`,
);
if (WIN) writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${join(fakeBin, "claude-stub.mjs")}" %*\r\n`);
else writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(fakeBin, "claude-stub.mjs")}" "$@"\n`, { mode: 0o755 });

// A pre-existing Codex notify command that must keep receiving the payload after install.
const notifyMarker = join(sandbox, "orig-notify.json");
writeFileSync(join(fakeBin, "orig-notify.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(notifyMarker)}, process.argv.at(-1));\n`);
const origNotify = [process.execPath, join(fakeBin, "orig-notify.mjs")];
const origToml = `notify = [${origNotify.map((v) => JSON.stringify(v)).join(", ")}]\nmodel = "x"\n`;
writeFileSync(join(home, ".codex", "config.toml"), origToml);

const env = { ...process.env };
for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AI_MEMORY_SYNC", "AI_MEMORY_SYNC_DIR", "AI_MEMORY_SYNC_HOME_OVERRIDE", "XDG_CONFIG_HOME", "CLAUDE_PROJECT_DIR"]) delete env[k];
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"), // read by the stub; the CLI resolves the same dir
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  AI_MEMORY_SYNC_ALLOW_TMP: "1", // the sandbox lives in the temp dir, which hooks normally skip
  PATH: `${fakeBin}${WIN ? ";" : ":"}${process.env.PATH}`,
});
writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = smoke\n\temail = smoke@example.invalid\n[init]\n\tdefaultBranch = main\n");

const cli = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`ai-memory-sync ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const readJ = (p) => JSON.parse(readFileSync(p, "utf8"));
const stateDir = join(home, ".ai-memory-sync");

/** Git Bash on Windows (not WSL's bash.exe); plain sh/bash elsewhere. */
function bashPath() {
  if (!WIN) return "bash";
  const root = join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", "..");
  for (const p of [join(root, "bin", "bash.exe"), "C:\\Program Files\\Git\\bin\\bash.exe"]) if (existsSync(p)) return p;
  return null;
}

function mkRepo(name) {
  const r = join(sandbox, name);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  writeFileSync(join(r, "AGENTS.md"), "# Rules\n");
  git(r, "add", "AGENTS.md");
  git(r, "commit", "-q", "-m", "init");
  return r;
}

/** Claude memory note for `repo`, in the folder Claude Code would use. */
async function claudeNote(repo, text) {
  process.env.AI_MEMORY_SYNC_HOME_OVERRIDE = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const { claudeSlug } = await import("../plugins/ai-memory-sync/lib/util.mjs");
  const mem = join(home, ".claude", "projects", claudeSlug(repo), "memory");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "note.md"), `---\nname: note\n---\n\n${text}\n`);
  return mem;
}

let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
};

/** Run a hook command string through the shell the tool would use. */
function runShell(shell, command, input) {
  // Codex runs hooks in the session cwd; pass it too in case a shell does not forward stdin.
  const opts = { env, input: JSON.stringify(input), encoding: "utf8", timeout: 60000, cwd: input.cwd || sandbox };
  const r =
    shell === "cmd"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { ...opts, windowsVerbatimArguments: true })
      : shell === "powershell"
        ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], opts)
        : spawnSync(shell, ["-c", command], opts);
  assert.equal(r.status, 0, `${shell}: ${command}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const shells = WIN ? ["cmd", "powershell", bashPath()].filter(Boolean) : ["sh"];

await step("install", () => {
  const out = cli(["install"]);
  assert.ok(existsSync(join(stateDir, "bin", "ai-memory-sync")), out);
  if (WIN) {
    assert.ok(existsSync(join(stateDir, "bin", "ai-memory-sync.cmd")));
    assert.ok(existsSync(join(home, ".local", "bin", "ai-memory-sync.cmd")), "copied shim in ~/.local/bin");
  }
  const calls = readFileSync(claudeLog, "utf8");
  assert.match(calls, /plugin marketplace add/);
  assert.match(calls, /plugin install ai-memory-sync@ai-memory-sync --scope user/);
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.ok(toml.includes('"codex-notify", "--"'), toml);
  assert.ok(readFileSync(join(home, ".codex", "hooks.json"), "utf8").includes("hook codex session-start"));
  assert.ok(readFileSync(join(home, ".cursor", "hooks.json"), "utf8").includes("hook cursor sessionStart"));
  const hook = readFileSync(join(stateDir, "git-template", "hooks", "post-checkout"), "utf8");
  assert.ok(hook.startsWith("#!/bin/sh\n") && !hook.includes("\r"), "post-checkout is LF sh");
  assert.ok(git(home, "config", "--global", "--get", "init.templateDir").includes("git-template"));
});

await step("install is idempotent", () => {
  const before = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
  cli(["install"]);
  assert.equal(readFileSync(join(home, ".codex", "hooks.json"), "utf8"), before);
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.equal(toml.split("codex-notify").length, 2, "one chain only");
});

await step("doctor: every global check ok", () => {
  const out = cli(["doctor", sandbox]);
  const global = out.split("Project")[0];
  const bad = global.split("\n").filter((l) => l.trim().startsWith("--"));
  assert.deepEqual(bad, [], out);
});

await step("shims run", () => {
  const sh = join(stateDir, "bin", "ai-memory-sync");
  if (WIN) {
    const cmd = join(stateDir, "bin", "ai-memory-sync.cmd");
    assert.equal(runShell("cmd", `"${cmd}" version`, {}).trim(), VERSION);
    assert.equal(runShell("powershell", `& '${cmd}' version`, {}).trim(), VERSION);
    const bash = bashPath();
    if (bash) assert.equal(runShell(bash, `sh '${fwd(sh)}' version`, {}).trim(), VERSION);
  } else {
    assert.equal(execFileSync(sh, ["version"], { env, encoding: "utf8" }).trim(), VERSION);
  }
});

await step("git clone runs the template post-checkout hook (local mode, clean status)", () => {
  const src = mkRepo("clone-src");
  const dst = join(sandbox, "clone-dst");
  execFileSync("git", ["clone", "-q", src, dst], { env, stdio: "pipe" });
  assert.ok(existsSync(join(dst, "docs", "ai-context", "memory", "shared", "README.md")), "scaffolded by the hook");
  assert.ok(existsSync(join(dst, "AGENTS.local.md")));
  assert.equal(git(dst, "status", "--porcelain"), "");
  assert.equal(git(dst, "config", "--local", "--get", "ai-memory-sync.mode"), "local");
});

await step("Codex hooks.json command runs in each shell", async () => {
  const cmd = readJ(join(home, ".codex", "hooks.json")).hooks.SessionStart.at(-1).hooks[0].command;
  for (const sh of shells) {
    const r = mkRepo(`codex-${sh.replace(/\W/g, "")}`);
    await claudeNote(r, `codex via ${sh}`);
    const out = runShell(sh, cmd, { cwd: r, hook_event_name: "SessionStart" });
    assert.equal(out, "", "SessionStart stdout stays empty");
    assert.ok(readFileSync(join(r, "AGENTS.local.md"), "utf8").includes(`codex via ${sh}`), `${sh}: memory synced`);
  }
});

await step("Cursor hooks.json sessionStart returns the memory as additional_context", async () => {
  const cmd = readJ(join(home, ".cursor", "hooks.json")).hooks.sessionStart.at(-1).command;
  const r = mkRepo("cursor-repo");
  await claudeNote(r, "cursor sees this");
  // Cursor on Windows may report workspace roots URI-style (/c:/Users/...)
  const root = WIN ? `/${fwd(r)}` : r;
  const out = JSON.parse(runShell(shells[0], cmd, { workspace_roots: [root], hook_event_name: "sessionStart" }));
  assert.ok(out.additional_context?.includes("cursor sees this"), JSON.stringify(out));
});

await step("Claude plugin hooks.json commands run under sh/Git Bash", async () => {
  const bash = bashPath();
  if (!bash) return console.log("     (skipped: no Git Bash)");
  const hooks = readJ(join(PLUGIN, "hooks", "hooks.json")).hooks;
  const r = mkRepo("claude-repo");
  const mem = await claudeNote(r, "first note");
  // Claude Code passes CLAUDE_PLUGIN_ROOT with forward slashes on Windows.
  const henv = { ...env, CLAUDE_PLUGIN_ROOT: fwd(PLUGIN) };
  const run = (event, input) => {
    const cmd = hooks[event][0].hooks[0].command;
    const p = spawnSync(bash, ["-c", cmd], { env: henv, input: JSON.stringify(input), encoding: "utf8", timeout: 60000 });
    assert.equal(p.status, 0, `${event}: ${p.stderr}`);
    return p.stdout;
  };
  assert.equal(run("SessionStart", { cwd: r, hook_event_name: "SessionStart", source: "startup" }), "");
  assert.ok(readFileSync(join(r, "AGENTS.local.md"), "utf8").includes("first note"));
  writeFileSync(join(mem, "second.md"), "second note\n");
  const fp = join(mem, "second.md"); // native separators, as Claude reports them
  run("PostToolUse", { cwd: join(sandbox, "elsewhere"), tool_name: "Write", tool_input: { file_path: fp } });
  assert.ok(readFileSync(join(r, "AGENTS.local.md"), "utf8").includes("second note"), "PostToolUse found the repo via the registry");
});

await step("Codex notify chain syncs and still calls the original notify", async () => {
  const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  const arr = JSON.parse(toml.match(/^notify = (\[.*\])$/m)[1]);
  const r = mkRepo("notify-repo");
  await claudeNote(r, "from notify");
  const payload = JSON.stringify({ type: "agent-turn-complete", cwd: r });
  const p = spawnSync(arr[0], [...arr.slice(1), payload], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(readFileSync(join(r, "AGENTS.local.md"), "utf8").includes("from notify"));
  for (let i = 0; i < 100 && !existsSync(notifyMarker); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(readFileSync(notifyMarker, "utf8"), payload, "original notify got the payload");
});

await step("uninstall restores everything", () => {
  cli(["uninstall"]);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), origToml);
  assert.ok(!existsSync(join(home, ".codex", "hooks.json")), "created by install, removed");
  assert.ok(!existsSync(join(home, ".cursor", "hooks.json")));
  assert.ok(!existsSync(join(stateDir, "app")) && !existsSync(join(stateDir, "bin")));
  assert.ok(!existsSync(join(home, ".local", "bin", WIN ? "ai-memory-sync.cmd" : "ai-memory-sync")));
  assert.throws(() => git(home, "config", "--global", "--get", "init.templateDir"));
  assert.match(readFileSync(claudeLog, "utf8"), /plugin uninstall ai-memory-sync@ai-memory-sync/);
});

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {}
console.log(`${passed} smoke steps passed${process.exitCode ? ", some FAILED" : ""}`);
