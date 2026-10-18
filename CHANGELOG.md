# Changelog

## 0.3.0

Smaller memory block. Every tool loads it at the start of every session, and in 0.2 it held the full text of every note.

- New `"block"` setting in `.ai-memory-sync.json`: `hybrid` (default), `index` or `full`.
  - `hybrid` inlines behavior rules (notes with `type: feedback` or `type: user`, at the top level or under `metadata:`) and pinned notes. Every other note becomes one index line: `- **name**: description → \`docs/ai-context/memory/<tool>/<file>.md\``.
  - `index` inlines pinned notes only. `full` is the 0.2 output, byte for byte.
- Frontmatter `pin: true` always inlines a note; `pin: false` keeps a rule in the index.
- Index lines without a `description` use the note's first heading or line.
- The block opens with one line telling agents to open a linked note when a task touches its topic, and that note files are the source of truth.
- `--block hybrid|index|full` on `init`, `sync` and `doctor` overrides the setting for one run.
- `doctor` reports the block mode, inlined/indexed counts, size in bytes and approximate tokens (~4 characters per token), and warns above 8 KB. It also warns about an unknown `"block"` value.
- Scrubbing still runs on the whole block, so it covers inlined rules and index descriptions. CRLF files and idempotent writes behave as in 0.2.
- Upgrading changes the `AGENTS.md` block of git-mode projects on the next sync. Set `"block": "full"` to keep the 0.2 output.

## 0.2.0

Windows support. macOS and Linux behaviour is unchanged.

- Windows install from PowerShell or cmd: a `.cmd` shim (plus an sh shim for Git Bash), copied to `~\.local\bin` when it exists, and printed PATH guidance otherwise. No symlinks are needed.
- Codex and Cursor hook commands on Windows use `node "C:/.../ai-memory-sync.mjs" ...`, which parses the same in cmd, PowerShell and Git Bash. Codex `notify` runs `node.exe` directly. Re-running `install` migrates an existing chain without duplicating the original notify command.
- Claude Code project slugs: Windows paths (`C:\Users\me\app` becomes `C--Users-me-app`), Git Bash and URI spellings (`/c/...`, `/c:/...`), and the 200-character cut with hash suffix that Claude Code applies to long paths.
- Path handling: `PATH`/`PATHEXT` lookup, case-insensitive path comparison and registry keys on Windows, drive roots, Windows temp dirs, 8.3 short names, memory paths with either separator.
- `npm`-style `.cmd` tools (`claude.cmd`) are spawned through cmd.exe, as Node requires since the 2024 batch-file fix.
- Git template hook stays POSIX sh with LF endings and calls `run.sh`, which finds `node.exe` under Git for Windows. `init.templateDir` is written with forward slashes.
- `run.sh` accepts `C:\...` and `C:/...` script paths (Claude Code passes `CLAUDE_PLUGIN_ROOT` with forward slashes on Windows).
- CRLF: tracked `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md` and `.git/info/exclude` keep their line endings; `@AGENTS.md` imports are detected in CRLF files. `.gitattributes` keeps scripts LF in Windows checkouts.
- Symlinks checked out as text files (`core.symlinks=false`) are detected and not overwritten.
- Atomic writes retry when Windows holds the target open (EPERM/EBUSY), then fall back to a direct write. Symlink resolution no longer shells out to `readlink`.
- `doctor` checks the `.cmd` shim, `node` on `PATH` and that the `notify` executable still exists.
- CI on ubuntu, macOS and Windows with Node 20 and 22, including an install/doctor/hooks/clone/uninstall smoke test in a fake home folder.

## 0.1.1

- Keep git mode out of the shared `.git/config` and protect worktree excludes.

## 0.1.0

- First release: CLI, Claude Code plugin marketplace, Codex and Cursor hooks, git clone template.
