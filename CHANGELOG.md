# Changelog

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
