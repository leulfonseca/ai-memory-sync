# ai-memory-sync

Keep your AI coding assistants' long-term memory **inside each project**, in a format that Claude Code, OpenAI Codex and Cursor all read natively. Every tool sees the notes of the others, a new machine starts with the same context, and sensitive data is scrubbed automatically.

- Zero runtime dependencies, Node.js 20 or newer, MIT license.
- macOS, Linux and Windows (PowerShell, cmd and Git Bash), tested in CI on all three.
- One command wires every tool installed on the machine; one command undoes it.

```sh
npx github:leulfonseca/ai-memory-sync install
```

### Windows

Requirements: [Node.js 20+](https://nodejs.org) on `PATH` and [Git for Windows](https://git-scm.com/downloads/win). Claude Code needs Git for Windows too, and runs plugin hooks in Git Bash.

```powershell
# PowerShell (or cmd). If PowerShell blocks npx.ps1, use npx.cmd instead of npx.
npx github:leulfonseca/ai-memory-sync install
ai-memory-sync doctor
```

If `ai-memory-sync` is not found afterwards, add the shim folder to your user `PATH` once (the installer prints this line too) and open a new terminal:

```powershell
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$env:USERPROFILE\.ai-memory-sync\bin", 'User')
```

What `install` writes on Windows (`~` is `%USERPROFILE%`):

| Path | What |
|---|---|
| `~\.ai-memory-sync\app\` | a copy of the CLI |
| `~\.ai-memory-sync\bin\ai-memory-sync.cmd` | shim for cmd and PowerShell (no `.ps1`, so no execution-policy prompt); also copied to `~\.local\bin\` when that folder exists (Claude Code's native installer puts it on `PATH`) |
| `~\.ai-memory-sync\bin\ai-memory-sync` | sh shim for Git Bash |
| `~\.codex\config.toml` (or `%CODEX_HOME%`) | `notify = ["C:\\...\\node.exe", "...\\ai-memory-sync.mjs", "codex-notify", "--", <your old notify>...]` |
| `~\.codex\hooks.json`, `~\.cursor\hooks.json` | hook commands of the form `node "C:/Users/you/.ai-memory-sync/app/bin/ai-memory-sync.mjs" hook ...`, which parse the same in cmd, PowerShell and Git Bash |
| `~\.codex\AGENTS.md` | the note telling Codex where to save memory |
| `~\.ai-memory-sync\git-template\hooks\post-checkout` | POSIX sh hook with LF endings; Git for Windows runs it with its own sh |
| `~\.gitconfig` | `init.templateDir = C:/Users/you/.ai-memory-sync/git-template` |
| Claude Code | the plugin, through `claude plugin marketplace add` / `claude plugin install` |

Claude Code's project memory lives in `~\.claude\projects\<slug>\memory`, where `C:\Users\you\proj` becomes `C--Users-you-proj`. Node.js upgrades that move `node.exe` need `ai-memory-sync install` again; `doctor` flags it.

## Three modes per project

Memories can hold private context. Committing them to a public repo would publish them, so **versioning memory is opt-in per project**.

| Mode | What happens | Default for |
|---|---|---|
| `local` | Memory lives in the project folder but never reaches git. `docs/ai-context/`, `.cursor/rules/ai-memory.mdc` and the generated local files are listed in `.git/info/exclude` (per clone, never committed). Tracked `AGENTS.md`/`CLAUDE.md` are never edited. | new clones, `scan --apply`, any project without a mode |
| `git` | Memory is committed with the project. `AGENTS.md` carries the generated "Project memory" block and `CLAUDE.md` imports `@AGENTS.md`. Teammates get the memory with `git pull`. | projects that already commit `docs/ai-context/` |
| `off` | ai-memory-sync does nothing in this project. | |

```sh
ai-memory-sync mode              # show the mode and where it comes from
ai-memory-sync mode git          # asks for confirmation; refuses on a public remote
ai-memory-sync mode git --force  # you really want it on a public repo
ai-memory-sync mode local        # removes the AGENTS.md block, untracks docs/ai-context (staged), warns about history
ai-memory-sync mode off
```

The mode is resolved in this order: `AI_MEMORY_SYNC=0` (off), `git config ai-memory-sync.mode` (per clone), `"mode"` in `.ai-memory-sync.json`, then auto-detection (`git` if `docs/ai-context/` is tracked, else `local`).

**Public-repo safety.** `mode git` checks every remote with `gh repo view --json visibility` and falls back to the unauthenticated GitHub API. A public remote, a non-GitHub remote or an unknown visibility counts as public, and the switch is refused unless you pass `--force`. Switching back to `local` stops future commits but cannot remove memory from past commits; the tool prints a warning when that applies.

## Layout in each project

```
docs/ai-context/
  README.md
  memory/
    README.md
    shared/   project facts for every tool (one fact per .md, optional name/description frontmatter)
    claude/   copied from Claude Code's project memory
    codex/    written by Codex
    cursor/   written by Cursor
.cursor/rules/ai-memory.mdc   alwaysApply rule
```

`ai-memory-sync sync` builds a block between `<!-- BEGIN:ai-memory ... -->` and `<!-- END:ai-memory -->` from the notes (frontmatter stripped, sensitive data scrubbed). Content outside the markers is never touched, other generated blocks (for example the Next.js agent-rules block) are preserved, and files are written only when their content changes.

### Block size: hybrid, index or full

Every tool loads the block at the start of every session, so its size is a per-session token cost that grows with each note. The `"block"` setting decides what is inlined:

| `"block"` | Inlined in full | Everything else | Typical cost |
|---|---|---|---|
| `hybrid` (default) | behavior rules: notes with `type: feedback` or `type: user` (top level or under `metadata:`, as Claude Code writes them), plus pinned notes | one index line per note | small and stable: rules are short, the index grows one line per note |
| `index` | pinned notes only | one index line per note | smallest |
| `full` | every note, grouped by source (the 0.2 layout, byte for byte) | | grows with every note |

An index line looks like this, with the path relative to the repo root so any agent can open it:

```md
- **project-stack**: stack, hosts and deploy targets → `docs/ai-context/memory/claude/project-stack.md`
```

The text after the name is the note's `description`, or its first heading or line when it has none. The block starts with one line telling agents to open the linked note when a task touches that topic, and that the note files are the source of truth.

Frontmatter flags, for any note:

- `pin: true` inlines the note in `hybrid` and `index` mode.
- `pin: false` keeps a rule as an index line in `hybrid` mode.

For Claude Code notes, set the flag in the source note in `~/.claude/projects/<slug>/memory/`: the repo copy is overwritten on each sync. `full` ignores both flags.

The tradeoff: `full` puts everything in front of the agent but costs tokens in every session, even when a task never touches most notes. `hybrid` keeps the rules that change behavior always loaded and makes the agent read a note (one file read) only when the task needs it. A real project with 11 notes went from about 18.9 KB (~4,700 tokens per session) in `full` to about 3.5 KB (~860 tokens) in `hybrid`.

```sh
ai-memory-sync sync --block full     # render one way for this run only (also init, doctor)
ai-memory-sync doctor                # shows "block: hybrid (2 inlined, 9 indexed); 3464 bytes, ~858 tokens per session"
```

`--block` is a one-run override; hooks use `"block"` from `.ai-memory-sync.json`, so set it there to keep it. `doctor` warns when the block is over 8 KB. Upgrading from 0.2 switches projects to `hybrid` on the next sync; set `"block": "full"` to keep the old output.

Where the block goes:

| Tool | git mode | local mode |
|---|---|---|
| Claude Code | `CLAUDE.md` imports `@AGENTS.md` | `CLAUDE.local.md` imports `@AGENTS.local.md` (and `@AGENTS.md` when needed). Claude reads `CLAUDE.local.md` natively. |
| Codex | `AGENTS.md` | `AGENTS.override.md`: a generated copy of `AGENTS.md` plus the block. Codex reads it *instead of* `AGENTS.md`. |
| Cursor | `AGENTS.md` + `.cursor/rules/ai-memory.mdc` | `.cursor/rules/ai-memory.mdc` with the block inside, plus the same text injected by the `sessionStart` hook |

## How it works per tool

| Tool | Mechanism installed by `install` | When it syncs |
|---|---|---|
| Claude Code | A plugin from this repo, which is also a plugin marketplace (`claude plugin marketplace add leulfonseca/ai-memory-sync`, `claude plugin install ai-memory-sync@ai-memory-sync`). | `SessionStart` (init + sync), `PostToolUse` on `Write|Edit|MultiEdit` inside `~/.claude/projects/*/memory/`, `Stop` |
| Codex | `notify` in `~/.codex/config.toml` (any existing notify command stays chained and still receives the payload), `SessionStart`/`Stop` hooks in `~/.codex/hooks.json`, and a note in `~/.codex/AGENTS.md` telling Codex to save notes in `docs/ai-context/memory/codex/`. | after every turn, and at session start once the hooks are approved |
| Cursor | User hooks in `~/.cursor/hooks.json` (existing hooks are kept). | `sessionStart`, `afterFileEdit` in `docs/ai-context/memory/`, `stop` |
| git clones | `init.templateDir` with a `post-checkout` hook (merged into your template dir if you already have one). | first checkout after a clone: scaffolds in **local** mode only, so no tracked file changes and no commits |

Claude Code stores project memory in `~/.claude/projects/<slug>/memory/*.md`, where `<slug>` is the absolute project path (the git root) with every non-alphanumeric character replaced by `-` (`/Users/me/CRM + App` becomes `-Users-me-CRM---App`, `C:\Users\me\app` becomes `C--Users-me-app`). Slugs longer than 200 characters are cut and get a hash suffix, as Claude Code does. The source files in `~/.claude` are only read, never modified. Copies are never deleted, because teammates' notes live in the same folder.

Hooks never scaffold your home folder or temp directories, and `AI_MEMORY_SYNC=0` disables everything.

## Commands

```sh
ai-memory-sync init [path] [--block hybrid|index|full]   # scaffold (idempotent)
ai-memory-sync sync [path] [--block hybrid|index|full]   # copy memories in, scrub, rebuild the block
ai-memory-sync mode [local|git|off] [path] [--yes] [--force]
ai-memory-sync scan [--root ~/Developer] [--apply] [--all] [--depth 5]
ai-memory-sync install | uninstall
ai-memory-sync doctor [path] [--block hybrid|index|full] # wiring, state, block size
```

`scan` lists git repos and marks the ones that already have Claude memory or a `docs/ai-context/` folder. `--apply` sets those up (local mode unless they are already in git mode). Repos with neither are skipped unless you pass `--all`.

### Project config (optional)

`.ai-memory-sync.json` at the project root:

```json
{
  "mode": "git",
  "block": "hybrid",
  "claudeMemoryDirs": ["~/.claude/projects/-Users-me-Work/memory"],
  "codexMemoryDirs": [],
  "cursorMemoryDirs": [],
  "copy": [{ "from": "../docs", "to": "docs/ai-context/maps" }],
  "envAllowKeys": ["B2_BUCKET"]
}
```

- `block`: `hybrid` (default), `index` or `full`; see [Block size](#block-size-hybrid-index-or-full).
- `claudeMemoryDirs`: extra memory folders, e.g. when you start Claude Code in a parent folder of the repo.
- `copy`: extra `.md` folders to mirror (scrubbed).
- `envAllowKeys`: `.env` keys whose values are not secret and may stay in notes.

## Privacy and scrubbing

Scrubbing is always on, in every mode. It runs on copied files, on notes written in the project and on the generated block. Matches become `[REDACTED:<kind>]`; the scrubber never aborts and never prints the values it found.

It covers:

- API keys: `sk-…`, `sk-ant-…`, `ghp_`/`gho_`/`github_pat_`, `AKIA…`, `xoxb-`/`xoxp-`, `hs_`/`hso_`, `AIza…`, Stripe `sk_live_`/`rk_live_`.
- JWTs and PEM private keys.
- `password|passwd|secret|token|api_key|senha|chave` followed by `=` or `:` and a value.
- URLs with credentials (`user:pass@host`), Bearer tokens, emails and phone numbers.
- Long high-entropy strings next to words like key or secret.
- Literal values from the project's `.env*` and `.dev.vars` files. Public client-side keys (`NEXT_PUBLIC_`, `VITE_`, …) and `envAllowKeys` are skipped.

The scrubber is a safety net, not a vault: keep secrets out of notes.

## Teams

In git mode the memory is part of the repo. Everyone's Claude, Codex and Cursor notes land in `docs/ai-context/memory/`, get committed with the code, and every teammate's tools read them on the next pull. Review memory diffs like any other change. Members who don't install ai-memory-sync still get the `AGENTS.md` block, which their tools read natively.

## Uninstall

```sh
ai-memory-sync uninstall
```

It removes the Claude plugin and marketplace, restores the original Codex `notify` command, removes only the hook entries and sections it added, unsets `init.templateDir` if it set it, and deletes `~/.ai-memory-sync`. Every file it edits is backed up first as `<file>.bak-ai-memory-sync-<timestamp>`. Project files are left in place.

On Windows, run the same command in PowerShell or cmd. It also removes `~\.local\bin\ai-memory-sync.cmd`. If you added `~\.ai-memory-sync\bin` to your user `PATH`, remove it in *Settings > System > About > Advanced system settings > Environment Variables*.

## Known limits

- **Codex** asks you to approve new hooks once (`/hooks`). Until then, the chained `notify` command keeps memory in sync after each turn. `AGENTS.override.md` (local mode) counts toward Codex's 32 KiB `project_doc_max_bytes` and is refreshed on each sync, so it can lag one turn behind edits to `AGENTS.md`.
- **Cursor** has no local override for `AGENTS.md`. Cursor on macOS has been reported to skip rule files listed in `.git/info/exclude`, so local mode also injects the memory through the `sessionStart` hook. Cursor's own "Memories" live in its cloud and cannot be copied.
- **Claude Code**: the plugin needs network once to install from GitHub; after that it runs offline from the plugin cache.
- **Windows**: Claude Code runs plugin hooks in Git Bash; without Git for Windows it falls back to PowerShell and the plugin's `sh` hooks do not run. Codex and Cursor hooks call `node` by name, so Node.js must be on `PATH`. Paths containing `%`, `$` or a backtick are not supported in hook commands (shells expand them); `doctor` warns.

---

## Português

**ai-memory-sync** guarda a memória de longo prazo dos assistentes de código (Claude Code, Codex, Cursor) dentro de cada projeto, num formato que as três ferramentas leem nativamente. Dados sensíveis são removidos automaticamente.

Instalar com um comando (macOS, Linux ou Windows; no Windows use PowerShell ou cmd, com Node.js 20+ e Git for Windows):

```sh
npx github:leulfonseca/ai-memory-sync install
```

**Modos por projeto.** Versionar memória é opcional, porque um repo público publicaria as notas.

- `local` (padrão): a memória fica na pasta do projeto, mas nunca vai para o git. Os caminhos entram em `.git/info/exclude` e o bloco gerado vai para arquivos locais (`CLAUDE.local.md`, `AGENTS.local.md`, `AGENTS.override.md`, `.cursor/rules/ai-memory.mdc`). `AGENTS.md` e `CLAUDE.md` rastreados não são alterados.
- `git`: a memória é commitada com o projeto, e o `AGENTS.md` recebe o bloco "Project memory". `ai-memory-sync mode git` pede confirmação e recusa remotos públicos (ou de visibilidade desconhecida) sem `--force`.
- `off`: nada acontece.

**Como funciona.** O Claude Code recebe um plugin com hooks (início de sessão, escrita na memória, fim de turno). O Codex recebe `notify` encadeado, hooks em `~/.codex/hooks.json` e uma instrução no `~/.codex/AGENTS.md`. O Cursor recebe hooks em `~/.cursor/hooks.json`. Clones novos recebem um `post-checkout` via `init.templateDir`, que prepara o projeto em modo local, sem commits.

**Tamanho do bloco.** O bloco é carregado em toda sessão. No modo `hybrid` (padrão), só as regras de comportamento (`type: feedback` ou `user`) e as notas com `pin: true` entram completas; as demais viram uma linha de índice com o caminho do arquivo, que o agente abre quando a tarefa toca no assunto. `"block": "index"` deixa só as fixadas, e `"block": "full"` reproduz o formato da 0.2. `ai-memory-sync doctor` mostra o tamanho em bytes e tokens aproximados.

**Privacidade.** O scrubbing está sempre ativo. Chaves de API, JWTs, chaves privadas, senhas, URLs com credenciais, tokens Bearer, e-mails, telefones, strings de alta entropia e valores dos arquivos `.env*` viram `[REDACTED:<tipo>]`. Os arquivos de origem em `~/.claude` nunca são modificados.

**Equipes.** No modo `git`, as notas de todos ficam em `docs/ai-context/memory/`, entram nos commits, e as ferramentas de cada pessoa leem tudo depois do `git pull`.

**Desinstalar:** `ai-memory-sync uninstall`. Ele restaura o que o `install` mudou e mantém os backups (`<arquivo>.bak-ai-memory-sync-<timestamp>`).
