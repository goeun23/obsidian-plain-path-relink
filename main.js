"use strict";

const { Plugin, PluginSettingTab, Setting, TFile, TFolder, Notice, normalizePath } = require("obsidian");

/**
 * 문서를 옮겼을 때 Obsidian 기본 기능(Automatically update internal links)이 고치지 않는 부분을 보완한다.
 * - wikilink·마크다운 링크는 Obsidian 이 고치므로 여기서는 건드리지 않는다.
 * - 갱신 대상 폴더 안 문서의 평문 경로(frontmatter 값, `folder/note.md` 같은 백틱 경로)를 새 경로로 바꾼다.
 * - 대상 밖 문서에 남은 옛 경로 언급은 바꾸지 않고 위치만 로그 파일에 남긴다.
 */
const DEFAULT_SETTINGS = {
  rewriteFolders: [], // 비어 있으면 볼트 전체
  logFile: "", // 비어 있으면 로그를 남기지 않는다
};
const DEBOUNCE_MS = 2000; // 폴더 이동 시 연달아 오는 이벤트를 한 번에 모은다
const NOT_PATH_BEFORE = "(?<!\\[\\[)(?<!\\]\\()(?<![\\p{L}\\p{N}_./\\-])";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkKey(path) {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

/** 문서 본문의 평문 경로(확장자까지 일치하는 것만)를 바꾼다. */
function replacePlain(text, moves) {
  let count = 0;
  for (const [oldPath, newPath] of moves) {
    const rx = new RegExp(NOT_PATH_BEFORE + escapeRe(oldPath) + "(?![\\p{L}\\p{N}_./\\-])", "gu");
    text = text.replace(rx, () => {
      count++;
      return newPath;
    });
  }
  return { text, count };
}

/** 옛 경로가 아직 남아 있는 줄 번호를 찾는다(링크 안은 Obsidian 몫이라 제외). */
function findLeftovers(text, moves) {
  const rxs = [...moves.keys()].map(
    (o) => new RegExp(NOT_PATH_BEFORE + escapeRe(linkKey(o)) + "(?=\\.md(?![\\p{L}\\p{N}_./\\-])|[\\]|#`'\")]|\\s*$)", "u")
  );
  const lines = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (rxs.some((rx) => rx.test(line))) lines.push(i + 1);
  });
  return lines;
}

/** 설정 화면의 폴더 목록을 `folder/` 꼴 접두사 배열로 바꾼다. */
function parseFolders(text) {
  return text
    .split("\n")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((s) => s + "/");
}

function inFolders(path, folders) {
  return !folders.length || folders.some((f) => path.startsWith(f));
}

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildLog(moves, changed, leftovers, date) {
  const out = [`\n## [${date}] relink | Plain paths updated after move`];
  for (const [o, n] of moves) out.push(`- Moved: \`${o}\` → \`${n}\``);
  const total = [...changed.values()].reduce((a, b) => a + b, 0);
  const files = [...changed.keys()].sort().map((p) => `\`${p}\``).join(", ");
  out.push(`- Updated: ${total} path(s) in ${changed.size} file(s)` + (files ? `: ${files}` : ""));
  if (leftovers.length) {
    const shown = leftovers.slice(0, 20).map((p) => `\`${p}\``).join(", ");
    const more = leftovers.length > 20 ? ` and ${leftovers.length - 20} more` : "";
    out.push(`- Not updated (outside rewrite folders or partial path): ${shown}${more}`);
  }
  return out.join("\n") + "\n";
}

class PlainPathRelinkSettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Folders to rewrite")
      .setDesc(
        "Plain-text paths are rewritten only in notes inside these folders, one per line. " +
          "Leave empty to rewrite the whole vault. Mentions found elsewhere are reported, not changed."
      )
      .addTextArea((ta) =>
        ta
          .setPlaceholder("wiki\nnotes/index")
          .setValue(this.plugin.settings.rewriteFolders.map((f) => f.slice(0, -1)).join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.rewriteFolders = parseFolders(v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Log file")
      .setDesc("Markdown note that receives a log entry after each move, such as log.md. Leave empty to disable logging.")
      .addText((t) =>
        t
          .setPlaceholder("log.md")
          .setValue(this.plugin.settings.logFile)
          .onChange(async (v) => {
            this.plugin.settings.logFile = v.trim() ? normalizePath(v.trim()) : "";
            await this.plugin.saveSettings();
          })
      );
  }
}

class PlainPathRelinkPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.pending = new Map();
    this.timer = null;
    this.addSettingTab(new PlainPathRelinkSettingTab(this));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.queue(file, oldPath)));
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  queue(file, oldPath) {
    if (file instanceof TFolder) {
      // 폴더 이동은 하위 파일마다 옛 경로를 계산한다
      const walk = (f) => {
        if (f instanceof TFile) this.pending.set(oldPath + f.path.slice(file.path.length), f.path);
        else if (f.children) f.children.forEach(walk);
      };
      walk(file);
    } else if (file instanceof TFile) {
      this.pending.set(oldPath, file.path);
    }
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  async flush() {
    const { rewriteFolders, logFile } = this.settings;
    const moves = new Map([...this.pending].filter(([o, n]) => o !== n && n !== logFile));
    this.pending.clear();
    this.timer = null;
    if (!moves.size) return;

    try {
      const changed = new Map();
      const leftovers = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (file.path === logFile) continue;
        let text = null;
        if (inFolders(file.path, rewriteFolders)) {
          let n = 0;
          await this.app.vault.process(file, (cur) => {
            const r = replacePlain(cur, moves);
            n = r.count;
            text = r.text;
            return r.text;
          });
          if (n) changed.set(file.path, n);
        }
        if (text === null) text = await this.app.vault.cachedRead(file);
        for (const line of findLeftovers(text, moves)) leftovers.push(`${file.path}:${line}`);
      }

      if (!changed.size && !leftovers.length) return;
      const log = logFile ? this.app.vault.getAbstractFileByPath(logFile) : null;
      if (log instanceof TFile) await this.app.vault.append(log, buildLog(moves, changed, leftovers, localDate()));
      new Notice(
        `Plain Path Relink: updated ${changed.size} file(s)` +
          (leftovers.length ? `, ${leftovers.length} mention(s) left unchanged` : "") +
          (log instanceof TFile ? ` (logged to ${logFile})` : ""),
        8000
      );
    } catch (e) {
      console.error("[plain-path-relink]", e);
      new Notice("Plain Path Relink: failed to update paths. See the developer console for details.");
    }
  }
}

module.exports = PlainPathRelinkPlugin;
module.exports._test = { replacePlain, findLeftovers, buildLog, parseFolders, inFolders };
