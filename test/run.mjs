// Tests for the scrubber, the AGENTS.md block and the modes. Run: node test/run.mjs
// Fake credentials are assembled at runtime so no secret-looking literal lives in this file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// realpath.native expands Windows 8.3 names (C:\Users\RUNNER~1), so git and node agree on paths.
const sandbox = mkdtempSync(join(realpathSync.native(tmpdir()), "ams-test-"));
const fakeHome = join(sandbox, "home");
mkdirSync(fakeHome, { recursive: true });
process.env.AI_MEMORY_SYNC_HOME_OVERRIDE = fakeHome;
process.env.AI_MEMORY_SYNC_DIR = join(fakeHome, ".ai-memory-sync");
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.AI_MEMORY_SYNC;

const { scrub, envLiterals } = await import("../plugins/ai-memory-sync/lib/scrub.mjs");
const P = await import("../plugins/ai-memory-sync/lib/project.mjs");
const I = await import("../plugins/ai-memory-sync/lib/install.mjs");
const U = await import("../plugins/ai-memory-sync/lib/util.mjs");
const { claudeSlug } = U;

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
};
const rnd = (n, abc = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789") => Array.from({ length: n }, (_, i) => abc[(i * 7 + 3) % abc.length]).join("");
const has = (s, kind) => s.includes(`[REDACTED:${kind}]`);

// ---------- scrubber ----------
const cases = [
  ["anthropic-key", `key ${"sk-" + "ant-api03-" + rnd(40)}`],
  ["openai-key", `use ${"sk-" + "proj-" + rnd(40)} here`],
  ["github-token", `token ${"gh" + "p_" + rnd(36)}`],
  ["github-token", `${"github" + "_pat_" + rnd(60)}`],
  ["aws-key", `aws ${"AK" + "IA" + "ABCDEFGHIJ123456"}`],
  ["slack-token", `${"xo" + "xb-" + "1234567890-" + rnd(20)}`],
  ["hs-key", `${"hs" + "o_" + rnd(30)}`],
  ["google-key", `${"AI" + "za" + rnd(35)}`],
  ["stripe-key", `${"sk" + "_live_" + rnd(30)}`],
  ["stripe-key", `${"rk" + "_live_" + rnd(30)}`],
  ["jwt", `${"ey" + "J" + rnd(20)}.${"ey" + "J" + rnd(30)}.${rnd(25)}`],
  ["private-key", `-----BEGIN RSA PRIVATE KEY-----\n${rnd(64)}\n-----END RSA PRIVATE KEY-----`],
  ["secret", "password: hunter2!x"],
  ["secret", 'api_key = "abcd1234efgh"'],
  ["secret", "senha=MinhaSenha123"],
  ["secret", "OPENAI_API_KEY=whatever-value-9"],
  ["credentials", "postgres://admin:s3cretpw@db.example.com:5432/app"],
  ["bearer", `Authorization: Bearer ${rnd(32)}`],
  ["email", "contact leul@example.com today"],
  ["phone", "call +55 11 98765-4321"],
  ["phone", "or (11) 98765-4321"],
  ["phone", "US +1 (415) 555-0132"],
  ["high-entropy", `the signing key is ${rnd(40)}`],
];
for (const [kind, input] of cases) {
  t(`scrub ${kind}: ${input.slice(0, 20)}`, () => {
    const out = scrub(input).text;
    assert.ok(has(out, kind), `expected [REDACTED:${kind}] in: ${out}`);
  });
}

t("scrub leaves prose, dates, versions, paths alone", () => {
  const prose =
    "Released 2026-10-18 as v1.2.3. The token: none. Run `node scripts/i18n-audit.mjs`. See src/lib/agents/llm.ts and git@github.com:o/r.git. Port 3000.\n" +
    "- Secret: dashboard API Keys page. GET /demo?apiKey=...&id=... Co-Authored-By: Bot <noreply@anthropic.com>";
  assert.equal(scrub(prose).text, prose);
});

t("scrub is idempotent", () => {
  const once = scrub(cases.map((c) => c[1]).join("\n")).text;
  assert.equal(scrub(once).text, once);
});

t("envLiterals skips public, allowlisted and trivial values", () => {
  const d = join(sandbox, "envdir");
  mkdirSync(d, { recursive: true });
  const secret = "s3cr3t-" + rnd(16);
  writeFileSync(join(d, ".env"), `NEXT_PUBLIC_URL=https://app.example.com\nBUCKET=my-media-bucket-01\nNODE_ENV=development\nPORT=3000\nTOKEN="${secret}"\n`);
  const lits = envLiterals(d, ["BUCKET"]);
  assert.deepEqual(lits, [secret]);
});
t("scrub redacts .env literals", () => {
  const lit = "supersecretvalue_" + rnd(8);
  const out = scrub(`the DB uses ${lit} in prod`, [lit]);
  assert.ok(has(out.text, "env"));
  assert.ok(!out.text.includes(lit));
  assert.equal(out.counts.env, 1);
});

t("scrub never throws", () => {
  assert.equal(scrub(undefined).text, "");
  assert.equal(scrub("x".repeat(200000)).text.length, 200000);
});

// ---------- block ----------
const NEXT_BLOCK = "<!-- BEGIN:nextjs-agent-rules -->\n\n## Next rules\n\n<!-- END:nextjs-agent-rules -->";

t("upsertBlock replaces only between markers and keeps other blocks", () => {
  const text = `# Title\n\n${NEXT_BLOCK}\n\nmanual text\n\n<!-- BEGIN:ai-memory (old) -->\nold\n<!-- END:ai-memory -->\n\nafter\n`;
  const out = P.upsertBlock(text, `${P.BEGIN}\nnew\n${P.END}`);
  assert.ok(out.includes(NEXT_BLOCK));
  assert.ok(out.includes("manual text") && out.includes("after\n"));
  assert.ok(out.includes("new") && !out.includes("old\n"));
  assert.equal(P.upsertBlock(out, `${P.BEGIN}\nnew\n${P.END}`), out);
});

t("parseNote strips frontmatter", () => {
  const n = P.parseNote('---\nname: Foo\ndescription: "bar baz"\ntype: project\n---\n\n# Body\ntext\n', "x.md");
  assert.equal(n.name, "Foo");
  assert.equal(n.description, "bar baz");
  assert.equal(n.body, "# Body\ntext");
});

t("removeBlock leaves the rest", () => {
  const text = `${NEXT_BLOCK}\n\n${P.BEGIN}\nx\n${P.END}\n`;
  assert.equal(P.removeBlock(text), `${NEXT_BLOCK}\n`);
});

t("claude slug maps every non-alphanumeric char to - (POSIX)", () => {
  assert.equal(claudeSlug("/Users/me/Developer/CRM + App", false), "-Users-me-Developer-CRM---App");
  assert.equal(claudeSlug("/home/me/src/my_app.v2", false), "-home-me-src-my-app-v2");
});

t("claude slug for Windows paths (path.win32)", () => {
  assert.equal(claudeSlug("C:\\Users\\me\\proj", true), "C--Users-me-proj");
  assert.equal(claudeSlug("C:/Users/me/proj", true), "C--Users-me-proj");
  assert.equal(claudeSlug("c:\\Users\\me\\My App", true), "C--Users-me-My-App");
  assert.equal(claudeSlug("/c/Users/me/proj", true), "C--Users-me-proj", "Git Bash spelling");
  assert.equal(claudeSlug("D:\\work\\a.b-c", true), "D--work-a-b-c");
});

t("claude slug truncates over 200 chars with a hash, like Claude Code", () => {
  const long = "/Users/me/" + "x".repeat(250);
  const s = claudeSlug(long, false);
  assert.ok(s.startsWith("-Users-me-xxx"));
  assert.match(s, /^.{200}-[0-9a-z]+$/);
  assert.notEqual(s, claudeSlug(long + "y", false));
  let h = 0; // Java-style 32-bit hash of the full path, base 36
  for (const c of long) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  assert.equal(s.slice(201), Math.abs(h).toString(36));
  assert.equal(U.claudeSlugs("C:\\Users\\me\\" + "y".repeat(250), true).length, 2, "both separator spellings are candidates");
  assert.deepEqual(U.claudeSlugs("C:\\short", true), ["C--short"]);
});

t("nativePath / samePath / isInside on Windows-style paths", () => {
  assert.equal(U.nativePath("/c/Users/me/x", true), "C:\\Users\\me\\x");
  assert.equal(U.nativePath("/c:/Users/me/x", true), "C:\\Users\\me\\x");
  assert.equal(U.nativePath("/cygdrive/d/w", true), "D:\\w");
  assert.equal(U.nativePath("c:/a/b", true), "C:\\a\\b");
  assert.equal(U.nativePath("/c/x", false), "/c/x", "identity on POSIX");
  assert.ok(U.samePath("C:\\Users\\Me\\Proj", "c:/users/me/proj", true));
  assert.ok(!U.samePath("/Users/Me", "/users/me", false));
  assert.ok(U.isInside("C:\\Users\\me\\AppData\\Local\\Temp\\x", "c:\\users\\me\\appdata\\local\\temp", true));
  assert.ok(!U.isInside("C:\\Users\\me\\TempX", "C:\\Users\\me\\Temp", true));
  assert.equal(U.pathKey("C:\\A\\b", true), U.pathKey("c:/a/B", true));
});

t("claudeMemoryDirOf accepts either separator", () => {
  const want = "C:\\Users\\me\\.claude\\projects\\C--Users-me-p\\memory";
  assert.equal(U.claudeMemoryDirOf("C:\\Users\\me\\.claude\\projects\\C--Users-me-p\\memory\\note.md", true), want);
  assert.equal(U.claudeMemoryDirOf("C:/Users/me/.claude/projects/C--Users-me-p/memory/n.md", true), want);
  assert.equal(U.claudeMemoryDirOf("/Users/me/.claude/projects/-Users-me-p/memory/n.md", false), "/Users/me/.claude/projects/-Users-me-p/memory");
  assert.equal(U.claudeMemoryDirOf("/Users/me/project/memory/n.md", false), null);
});

t("CRLF files keep their line endings", () => {
  assert.equal(U.withEol("a\r\nb\r\n", "a\nb\nc\n"), "a\r\nb\r\nc\r\n");
  assert.equal(U.withEol("a\nb\n", "x\n"), "x\n");
  assert.equal(U.withEol(null, "x\n"), "x\n");
});

t("Windows hook commands: node + quoted forward-slash path; notify runs node.exe directly", () => {
  const cli = "C:\\Users\\John Smith\\.ai-memory-sync\\app\\bin\\ai-memory-sync.mjs";
  assert.equal(I.hookCommand("hook codex stop", true, cli), 'node "C:/Users/John Smith/.ai-memory-sync/app/bin/ai-memory-sync.mjs" hook codex stop');
  assert.ok(!I.hookCommand("hook codex stop", false).startsWith("node "), "POSIX keeps the shim");
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const orig = 'notify = ["C:\\\\tools\\\\n.exe", "x"]\r\nmodel = "m"\r\n';
  const chained = I.notifyWithChain(orig, I.notifyPrefix(true, node, cli));
  assert.ok(chained.startsWith(`notify = [${JSON.stringify(node)}, ${JSON.stringify(cli)}, "codex-notify", "--", "C:\\\\tools\\\\n.exe", "x"]`));
  assert.equal(I.notifyWithoutChain(chained), orig);
  // switching prefix (POSIX shim <-> Windows node) keeps the original command exactly once
  assert.ok(I.notifyWithChain(chained, ["/x/shim"]).startsWith('notify = ["/x/shim", "codex-notify", "--", "C:'));
});

t("Windows shims: .cmd with CRLF, sh shim with forward slashes", () => {
  const files = I.shimFiles(true, "C:\\Program Files\\nodejs\\node.exe");
  const cmd = files.find((f) => f.path.endsWith(".cmd"));
  assert.ok(cmd && cmd.content.includes("\r\n") && cmd.content.includes("%*"));
  assert.ok(cmd.content.includes('set "AMS_NODE=C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(!files[0].content.split("\n")[2].includes("\\"), "sh shim has no backslashes");
  assert.equal(I.shimFiles(false).length, 1);
});

t("shell scripts in the repo use LF (sh fails on CR)", () => {
  const runSh = readFileSync(fileURLToPath(new URL("../plugins/ai-memory-sync/bin/run.sh", import.meta.url)), "utf8");
  assert.ok(!runSh.includes("\r"));
});

// ---------- modes (real git repos in the sandbox) ----------
const gitc = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function mkRepo(name) {
  const r = join(sandbox, name);
  mkdirSync(r, { recursive: true });
  gitc(r, "init", "-q");
  gitc(r, "config", "user.email", "t@t");
  gitc(r, "config", "user.name", "t");
  writeFileSync(join(r, "AGENTS.md"), `${NEXT_BLOCK}\n\n# Team rules\n`);
  writeFileSync(join(r, "CLAUDE.md"), "# Claude notes\n");
  writeFileSync(join(r, ".gitignore"), ".env*\n");
  writeFileSync(join(r, ".env.local"), `SECRET_THING=${"verysecret-" + rnd(12)}\n`);
  gitc(r, "add", "AGENTS.md", "CLAUDE.md", ".gitignore");
  gitc(r, "commit", "-q", "-m", "init");
  // Claude memory for this path, with a secret inside.
  const mem = join(fakeHome, ".claude", "projects", claudeSlug(r), "memory");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), "- [Fact](fact.md)\n");
  writeFileSync(join(mem, "fact.md"), `---\nname: fact\ndescription: a fact\n---\n\nUse port 3000. password: Abc12345xyz. env ${readFileSync(join(r, ".env.local"), "utf8").split("=")[1].trim()}\n`);
  return { r, mem };
}

t("local mode: no tracked file changes, block in excluded local files", () => {
  const { r, mem } = mkRepo("local-repo");
  const before = readFileSync(join(mem, "fact.md"), "utf8");
  P.init(r);
  const s = P.sync(r);
  assert.equal(s.mode, "local");
  assert.equal(gitc(r, "status", "--porcelain"), "", "git status must be clean in local mode");
  const local = readFileSync(join(r, "AGENTS.local.md"), "utf8");
  assert.ok(local.includes("#### fact (a fact)"));
  assert.ok(local.includes("[REDACTED:secret]") && local.includes("[REDACTED:env]"));
  assert.ok(readFileSync(join(r, "CLAUDE.local.md"), "utf8").includes("@AGENTS.local.md"));
  assert.ok(readFileSync(join(r, "AGENTS.override.md"), "utf8").includes("# Team rules"));
  assert.ok(readFileSync(join(r, P.MDC), "utf8").includes("alwaysApply: true"));
  assert.equal(readFileSync(join(mem, "fact.md"), "utf8"), before, "source memory must not change");
  const copied = readFileSync(join(r, P.MEM, "claude", "fact.md"), "utf8");
  assert.ok(!copied.includes("Abc12345xyz"));
  // only writes when changed
  assert.deepEqual(P.sync(r).changed, []);
});

t("git mode: block in AGENTS.md, CLAUDE.md imports it, Next.js block kept; back to local", () => {
  const { r } = mkRepo("git-repo");
  P.init(r);
  const logs = [];
  P.switchMode(r, "git", (s) => logs.push(s));
  const agents = readFileSync(join(r, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(NEXT_BLOCK) && agents.includes("# Team rules"));
  assert.ok(agents.includes(P.SECTION_HEADING) && agents.includes(P.BEGIN));
  assert.ok(/^@AGENTS\.md$/m.test(readFileSync(join(r, "CLAUDE.md"), "utf8")));
  assert.ok(readFileSync(join(r, "CLAUDE.md"), "utf8").includes("# Claude notes"));
  assert.ok(!existsSync(join(r, "AGENTS.local.md")));
  assert.equal(P.resolveMode(r).mode, "git");
  gitc(r, "add", "-A");
  gitc(r, "commit", "-q", "-m", "memory");
  const w = P.switchMode(r, "local", () => {}).warnings;
  assert.ok(w.some((x) => x.includes("past commits")));
  const agents2 = readFileSync(join(r, "AGENTS.md"), "utf8");
  assert.ok(!agents2.includes(P.BEGIN_PREFIX) && agents2.includes(NEXT_BLOCK));
  assert.ok(existsSync(join(r, "AGENTS.local.md")));
  assert.equal(gitc(r, "ls-files", "--", P.CTX), "");
});

t("local mode in a worktree never edits the exclude shared with a git-mode worktree", () => {
  const { r } = mkRepo("wt-main");
  gitc(r, "branch", "old");
  P.switchMode(r, "git", () => {});
  gitc(r, "add", "-A");
  gitc(r, "commit", "-q", "-m", "memory");
  assert.throws(() => gitc(r, "config", "--local", "--get", "ai-memory-sync.mode"), "git mode must not live in .git/config");
  const wt = join(sandbox, "wt-old");
  gitc(r, "worktree", "add", "-q", wt, "old");
  const res = P.init(wt);
  assert.equal(res.mode, "local");
  assert.ok(res.warnings.some((w) => w.includes("shared .git/info/exclude")));
  const ex = P.excludePath(r);
  assert.ok(!existsSync(ex) || !readFileSync(ex, "utf8").includes("ai-memory-sync"));
  assert.equal(P.resolveMode(r).mode, "git");
});

t("off mode does nothing", () => {
  const { r } = mkRepo("off-repo");
  gitc(r, "config", "ai-memory-sync.mode", "off");
  assert.deepEqual(P.sync(r).changed, []);
  assert.ok(!existsSync(join(r, P.CTX)));
});

t("codex notify chain round-trips", () => {
  const orig = 'notify = ["/x/y z/app", "turn-ended"]\nmodel = "m"\n\n[t]\nnotify = "not top-level"\n';
  const chained = I.notifyWithChain(orig, I.notifyPrefix(false));
  assert.ok(chained.startsWith(`notify = [${JSON.stringify(I.SHIM)}, "codex-notify", "--", "/x/y z/app", "turn-ended"]`));
  assert.equal(I.notifyWithChain(chained, I.notifyPrefix(false)), chained, "idempotent");
  assert.equal(I.notifyWithoutChain(chained), orig);
  assert.equal(I.notifyWithoutChain(I.notifyWithChain('model = "m"\n')), 'model = "m"\n');
});

t("CRLF AGENTS.md (core.autocrlf) stays CRLF in git mode and the block is idempotent", () => {
  const { r } = mkRepo("crlf-repo");
  writeFileSync(join(r, "AGENTS.md"), "# Team rules\r\n\r\nBe nice.\r\n");
  writeFileSync(join(r, "CLAUDE.md"), "# Claude\r\n@AGENTS.md\r\n");
  P.switchMode(r, "git", () => {});
  const a = readFileSync(join(r, "AGENTS.md"), "utf8");
  assert.ok(a.includes(P.BEGIN) && !/[^\r]\n/.test(a), "all line endings CRLF");
  assert.equal(readFileSync(join(r, "CLAUDE.md"), "utf8"), "# Claude\r\n@AGENTS.md\r\n", "existing CRLF import detected");
  assert.deepEqual(P.sync(r).changed, []);
});

t("symlink checked out as a text file (core.symlinks=false) is not overwritten", () => {
  const { r } = mkRepo("symlink-text-repo");
  // record CLAUDE.md as a symlink to AGENTS.md in the index, then check it out as plain text
  const blob = execFileSync("git", ["-C", r, "hash-object", "-w", "--stdin"], { input: "AGENTS.md" }).toString().trim();
  gitc(r, "update-index", "--add", "--cacheinfo", `120000,${blob},CLAUDE.md`);
  gitc(r, "commit", "-q", "-m", "link");
  writeFileSync(join(r, "CLAUDE.md"), "AGENTS.md");
  P.switchMode(r, "git", () => {});
  assert.equal(readFileSync(join(r, "CLAUDE.md"), "utf8"), "AGENTS.md");
  assert.ok(readFileSync(join(r, "AGENTS.md"), "utf8").includes(P.BEGIN));
});

t("Codex global notes match the project path with either separator", () => {
  assert.ok(P.mentionsPath("see C:/Users/me/Proj for x", "C:\\Users\\me\\proj", true));
  assert.ok(!P.mentionsPath("see /Users/me/Proj", "/Users/me/proj", false));
});

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {} // Windows: a file can stay locked for a moment
console.log(`${passed} tests passed${process.exitCode ? ", some FAILED" : ""}`);
