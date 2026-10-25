# Plain Path Relink

Obsidian updates wikilinks and Markdown links when you move a note, but it leaves plain-text paths alone. This plugin rewrites those paths too, so references such as these keep pointing to the right file:

```yaml
---
source_path: sources/2026/meeting-notes.md
---
```

```markdown
The original lives at `sources/2026/meeting-notes.md`.
```

한국어 요약: 문서나 폴더를 옮기면 Obsidian이 고치지 않는 평문 경로(frontmatter 값, 백틱 경로)를 새 경로로 바꾸고, 바꾸지 않은 언급은 로그 파일에 위치를 남깁니다.

## How it works

1. You move or rename a note or folder inside Obsidian.
2. After a 2-second pause (so a folder move is handled as one batch), the plugin scans every Markdown note.
3. In the **folders to rewrite**, every exact occurrence of the old path, including the `.md` extension, is replaced with the new path.
4. Mentions it does not change are collected with their file and line number:
   - exact paths in notes outside the rewrite folders
   - partial paths without the extension, such as `` `sources/2026/meeting-notes` ``
5. A notice summarizes the result. If a log file is set, an entry is appended to it.

Links (`[[...]]` and `[text](...)`) are never touched, because Obsidian already updates them. Turn on **Settings → Files and links → Automatically update internal links** for those.

Moves made outside Obsidian (in a file manager, with git, or with scripts) do not fire Obsidian's rename event, so this plugin cannot see them.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Folders to rewrite | empty (whole vault) | One folder per line. Paths are rewritten only in notes inside these folders. Use this to keep source or archive notes unchanged. |
| Log file | empty (no log) | Path of an existing Markdown note, such as `log.md`. Each move appends an entry like the one below. |

```markdown
## [2026-10-25] relink | Plain paths updated after move
- Moved: `sources/a.md` → `sources/2026/a.md`
- Updated: 2 path(s) in 1 file(s): `wiki/summary.md`
- Not updated (outside rewrite folders or partial path): `sources/index.md:12`
```

## Installation

Install from **Settings → Community plugins → Browse** and search for "Plain Path Relink".

Manual install: download `main.js` and `manifest.json` from the latest release into `<vault>/.obsidian/plugins/plain-path-relink/`, then enable the plugin.

## License

[MIT](LICENSE)
