# ai-memory-sync

Keep your AI coding assistants' long-term memory **inside each project**, in a format that Claude Code, OpenAI Codex and Cursor all read natively. Every tool sees the notes of the others, a new machine starts with the same context, and sensitive data is scrubbed automatically.

- Zero runtime dependencies, Node.js 20 or newer, MIT license.
- One command wires every tool installed on the machine; one command undoes it.

```sh
npx github:leulfonseca/ai-memory-sync install
```

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

`ai-memory-sync sync` merges every note (frontmatter stripped, grouped by source) into a block between `<!-- BEGIN:ai-memory ... -->` and `<!-- END:ai-memory -->`. Content outside the markers is never touched, other generated blocks (for example the Next.js agent-rules block) are preserved, and files are written only when their content changes.

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

Claude Code stores project memory in `~/.claude/projects/<slug>/memory/*.md`, where `<slug>` is the absolute project path with every non-alphanumeric character replaced by `-` (`/Users/me/CRM + App` becomes `-Users-me-CRM---App`). The source files in `~/.claude` are only read, never modified. Copies are never deleted, because teammates' notes live in the same folder.

Hooks never scaffold your home folder or temp directories, and `AI_MEMORY_SYNC=0` disables everything.

## Commands

```sh
ai-memory-sync init [path]       # scaffold (idempotent)
ai-memory-sync sync [path]       # copy memories in, scrub, rebuild the block
ai-memory-sync mode [local|git|off] [path] [--yes] [--force]
ai-memory-sync scan [--root ~/Developer] [--apply] [--all] [--depth 5]
ai-memory-sync install | uninstall
ai-memory-sync doctor [path]
```

`scan` lists git repos and marks the ones that already have Claude memory or a `docs/ai-context/` folder. `--apply` sets those up (local mode unless they are already in git mode). Repos with neither are skipped unless you pass `--all`.

### Project config (optional)

`.ai-memory-sync.json` at the project root:

```json
{
  "mode": "git",
  "claudeMemoryDirs": ["~/.claude/projects/-Users-me-Work/memory"],
  "codexMemoryDirs": [],
  "cursorMemoryDirs": [],
  "copy": [{ "from": "../docs", "to": "docs/ai-context/maps" }],
  "envAllowKeys": ["B2_BUCKET"]
}
```

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

## Known limits

- **Codex** asks you to approve new hooks once (`/hooks`). Until then, the chained `notify` command keeps memory in sync after each turn. `AGENTS.override.md` (local mode) counts toward Codex's 32 KiB `project_doc_max_bytes` and is refreshed on each sync, so it can lag one turn behind edits to `AGENTS.md`.
- **Cursor** has no local override for `AGENTS.md`. Cursor on macOS has been reported to skip rule files listed in `.git/info/exclude`, so local mode also injects the memory through the `sessionStart` hook. Cursor's own "Memories" live in its cloud and cannot be copied.
- **Claude Code**: the plugin needs network once to install from GitHub; after that it runs offline from the plugin cache.

---

## Português

**ai-memory-sync** guarda a memória de longo prazo dos assistentes de código (Claude Code, Codex, Cursor) dentro de cada projeto, num formato que as três ferramentas leem nativamente. Dados sensíveis são removidos automaticamente.

Instalar com um comando:

```sh
npx github:leulfonseca/ai-memory-sync install
```

**Modos por projeto.** Versionar memória é opcional, porque um repo público publicaria as notas.

- `local` (padrão): a memória fica na pasta do projeto, mas nunca vai para o git. Os caminhos entram em `.git/info/exclude` e o bloco gerado vai para arquivos locais (`CLAUDE.local.md`, `AGENTS.local.md`, `AGENTS.override.md`, `.cursor/rules/ai-memory.mdc`). `AGENTS.md` e `CLAUDE.md` rastreados não são alterados.
- `git`: a memória é commitada com o projeto, e o `AGENTS.md` recebe o bloco "Project memory". `ai-memory-sync mode git` pede confirmação e recusa remotos públicos (ou de visibilidade desconhecida) sem `--force`.
- `off`: nada acontece.

**Como funciona.** O Claude Code recebe um plugin com hooks (início de sessão, escrita na memória, fim de turno). O Codex recebe `notify` encadeado, hooks em `~/.codex/hooks.json` e uma instrução no `~/.codex/AGENTS.md`. O Cursor recebe hooks em `~/.cursor/hooks.json`. Clones novos recebem um `post-checkout` via `init.templateDir`, que prepara o projeto em modo local, sem commits.

**Privacidade.** O scrubbing está sempre ativo. Chaves de API, JWTs, chaves privadas, senhas, URLs com credenciais, tokens Bearer, e-mails, telefones, strings de alta entropia e valores dos arquivos `.env*` viram `[REDACTED:<tipo>]`. Os arquivos de origem em `~/.claude` nunca são modificados.

**Equipes.** No modo `git`, as notas de todos ficam em `docs/ai-context/memory/`, entram nos commits, e as ferramentas de cada pessoa leem tudo depois do `git pull`.

**Desinstalar:** `ai-memory-sync uninstall`. Ele restaura o que o `install` mudou e mantém os backups (`<arquivo>.bak-ai-memory-sync-<timestamp>`).
