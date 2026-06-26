const {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "daily-work-plan-view";
const DEFAULT_SETTINGS = {
  sourceFolder: "所有笔记/待办事项/每日事项",
  defaultPriority: "中",
  defaultStartTime: "09:00",
  defaultEndTime: "18:00",
};

const DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-M-D",
  "YYYY-MM-DDTHH:mm:ss",
  "YYYY-M-DTHH:mm:ss",
  "YYYY年MM月DD日",
  "YYYY年M月D日",
  "YYYY/MM/DD",
  "YYYY/M/D",
];

function m() {
  return window.moment;
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (Array.isArray(value.values)) return value.values.map(textValue).filter(Boolean).join(" ");
  return String(value).trim();
}

function firstTextValue(value) {
  if (Array.isArray(value)) return textValue(value[0]);
  if (Array.isArray(value?.values)) return textValue(value.values[0]);
  return textValue(value);
}

function parseDate(value) {
  const raw = textValue(value);
  if (!raw) return null;

  const parsed = m()(raw, DATE_FORMATS, true);
  if (parsed.isValid()) return parsed.clone().startOf("day");

  const loose = m()(raw);
  return loose.isValid() ? loose.clone().startOf("day") : null;
}

function parseFileNameDate(file) {
  const match = file.basename.match(/^(\d{4})[-年]?(\d{1,2})[-月]?(\d{1,2})/);
  if (!match) return null;
  const parsed = m()(`${match[1]}-${match[2]}-${match[3]}`, "YYYY-M-D", true);
  return parsed.isValid() ? parsed.startOf("day") : null;
}

function dateKey(date) {
  return date ? date.format("YYYY-MM-DD") : "";
}

function dateLabel(date) {
  return date ? date.format("YYYY-MM-DD") : "未设置";
}

function cleanTaskText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCompletedStatus(value) {
  const status = textValue(value).toLowerCase();
  return ["true", "完成", "已完成", "done", "completed", "yes"].includes(status);
}

function isOpenStatus(value) {
  const status = textValue(value).toLowerCase();
  if (!status) return true;
  return ["false", "未完成", "待办", "进行中", "todo", "open", "doing", "no"].includes(status);
}

function priorityText(value) {
  return firstTextValue(value) || "未设";
}

function priorityRank(value) {
  const priority = priorityText(value);
  if (/高|urgent|high/i.test(priority)) return 0;
  if (/中|medium|normal/i.test(priority)) return 1;
  if (/低|low/i.test(priority)) return 2;
  return 3;
}

function normalizeFolder(folder) {
  return normalizePath(folder || "").replace(/^\/+|\/+$/g, "");
}

function hasExplicitSchedule(frontmatter) {
  return Boolean(
    textValue(frontmatter?.date) ||
      textValue(frontmatter?.["开始时间"]) ||
      textValue(frontmatter?.["结束时间"])
  );
}

function safeFileName(value) {
  return cleanTaskText(value)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "未命名事项";
}

class DailyWorkPlanPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new DailyWorkPlanView(leaf, this));

    this.addRibbonIcon("calendar-check", "每日工作计划", () => this.activateView());

    this.addCommand({
      id: "open-daily-work-plan",
      name: "打开每日工作计划",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "create-daily-work-item",
      name: "新增每日事项",
      callback: () => this.openNewTaskModal(),
    });

    this.addSettingTab(new DailyWorkPlanSettingTab(this.app, this));

    this.registerEvent(
      this.app.metadataCache.on("changed", file => {
        if (file instanceof TFile && this.isSourceFile(file)) {
          window.clearTimeout(this.refreshTimer);
          this.refreshTimer = window.setTimeout(() => this.refreshViews(), 500);
        }
      })
    );
  }

  onunload() {
    window.clearTimeout(this.refreshTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  getSourceFolder() {
    return normalizeFolder(this.settings.sourceFolder);
  }

  isSourceFile(file) {
    const folder = this.getSourceFolder();
    return Boolean(folder) && file.path.startsWith(`${folder}/`) && file.extension === "md";
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof DailyWorkPlanView) await view.refresh();
    }
  }

  openNewTaskModal() {
    new NewDailyTaskModal(this.app, this, async file => {
      await this.refreshViews();
      if (file) await this.openFile(file, 0);
    }).open();
  }

  async loadItems() {
    const files = this.app.vault.getMarkdownFiles().filter(file => this.isSourceFile(file));
    const items = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter || {};
      const content = await this.app.vault.cachedRead(file);
      const taskMatches = this.parseTasks(content);
      const plannedDate = parseDate(frontmatter.date) || parseDate(frontmatter["开始时间"]) || parseFileNameDate(file);
      const dueDate = parseDate(frontmatter["结束时间"]) || plannedDate;
      const status = textValue(frontmatter["待办状态"]);
      const priority = priorityText(frontmatter["优先级"]);
      const rank = priorityRank(frontmatter["优先级"]);

      if (taskMatches.length) {
        for (const task of taskMatches) {
          items.push({
            id: `${file.path}:${task.line}`,
            type: "task",
            file,
            line: task.line,
            text: task.text || file.basename,
            completed: task.completed,
            date: plannedDate,
            due: dueDate,
            priority,
            priorityRank: rank,
            status,
            mtime: file.stat.mtime,
          });
        }
        continue;
      }

      if (!status && !hasExplicitSchedule(frontmatter)) continue;

      const completed = isCompletedStatus(frontmatter["待办状态"]);
      const open = isOpenStatus(frontmatter["待办状态"]);
      items.push({
        id: `${file.path}:note`,
        type: "note",
        file,
        line: 0,
        text: file.basename,
        completed: completed ? true : !open,
        date: plannedDate,
        due: dueDate,
        priority,
        priorityRank: rank,
        status,
        mtime: file.stat.mtime,
      });
    }

    return items;
  }

  parseTasks(content) {
    const tasks = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
      if (!match) continue;
      tasks.push({
        line: index + 1,
        completed: match[2].toLowerCase() === "x",
        text: cleanTaskText(match[3]),
      });
    }
    return tasks;
  }

  async setItemCompleted(item, completed) {
    if (item.type === "task") {
      await this.updateTaskLine(item.file, item.line, completed);
    } else {
      await this.updateNoteStatus(item.file, completed);
    }
    await this.refreshViews();
  }

  async updateTaskLine(file, lineNumber, completed) {
    await this.app.vault.process(file, content => {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const index = lineNumber - 1;
      if (!lines[index]) return content;
      lines[index] = lines[index].replace(
        /^(\s*[-*]\s+\[)[ xX](\]\s+)/,
        `$1${completed ? "x" : " "}$2`
      );
      return lines.join(eol);
    });
  }

  async updateNoteStatus(file, completed) {
    const status = completed ? "完成" : "未完成";
    if (this.app.fileManager?.processFrontMatter) {
      try {
        await this.app.fileManager.processFrontMatter(file, frontmatter => {
          frontmatter["待办状态"] = status;
        });
        return;
      } catch (error) {
        console.warn("processFrontMatter failed, falling back to text update", error);
      }
    }

    await this.app.vault.process(file, content => this.replaceFrontmatterStatus(content, status));
  }

  replaceFrontmatterStatus(content, status) {
    const lines = content.split(/\r?\n/);
    const eol = content.includes("\r\n") ? "\r\n" : "\n";

    if (lines[0] !== "---") {
      return `---${eol}待办状态: ${status}${eol}---${eol}${content}`;
    }

    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) return content;

    for (let index = 1; index < end; index += 1) {
      if (/^待办状态\s*:/.test(lines[index])) {
        lines[index] = `待办状态: ${status}`;
        return lines.join(eol);
      }
    }

    lines.splice(1, 0, `待办状态: ${status}`);
    return lines.join(eol);
  }

  async openFile(file, line) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line } });
  }

  async ensureSourceFolder() {
    const folder = this.getSourceFolder();
    if (!folder) throw new Error("未设置数据目录");

    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
    return folder;
  }

  async createTask(input) {
    const folder = await this.ensureSourceFolder();
    const date = input.date || m()().format("YYYY-MM-DD");
    const title = cleanTaskText(input.title);
    if (!title) throw new Error("请填写任务内容");

    const baseName = `${date} ${safeFileName(title)}`;
    let path = `${folder}/${baseName}.md`;
    let index = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = `${folder}/${baseName} ${index}.md`;
      index += 1;
    }

    const start = `${date}T${input.startTime || this.settings.defaultStartTime}:00`;
    const end = `${date}T${input.endTime || this.settings.defaultEndTime}:00`;
    const content = [
      "---",
      `date: ${date}`,
      "待办状态: 未完成",
      "类别: 每日事项",
      "tags:",
      "  - 每日计划",
      `开始时间: ${start}`,
      `结束时间: ${end}`,
      `优先级: ${input.priority || this.settings.defaultPriority}`,
      "备注:",
      "---",
      `- [ ] ${title}`,
      "",
    ].join("\n");

    return this.app.vault.create(path, content);
  }
}

class DailyWorkPlanView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeFilter = "today";
    this.searchText = "";
    this.items = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "每日工作计划";
  }

  getIcon() {
    return "calendar-check";
  }

  async onOpen() {
    this.contentEl.addClass("daily-work-plan");
    await this.refresh();
  }

  async refresh() {
    this.items = await this.plugin.loadItems();
    this.render();
  }

  render() {
    this.contentEl.empty();
    this.today = m()().startOf("day");
    this.next7 = this.today.clone().add(7, "days");

    const header = this.contentEl.createDiv({ cls: "dwp-header" });
    header.createEl("h2", { text: "每日工作计划" });
    const actions = header.createDiv({ cls: "dwp-actions" });
    this.iconButton(actions, "plus", "新增每日事项", () => this.plugin.openNewTaskModal());
    this.iconButton(actions, "refresh-cw", "刷新", () => this.refresh());

    this.renderStats();
    this.renderControls();
    this.renderTaskList();
  }

  iconButton(parent, icon, label, callback) {
    const button = parent.createEl("button", {
      cls: "dwp-icon-button",
      attr: { "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", callback);
    return button;
  }

  getStats() {
    const open = this.items.filter(item => !item.completed);
    return {
      today: open.filter(item => this.isToday(item)).length,
      overdue: open.filter(item => this.isOverdue(item)).length,
      week: open.filter(item => this.isWeek(item)).length,
      open: open.length,
      done: this.items.length - open.length,
      inbox: open.filter(item => !item.date && !item.due).length,
    };
  }

  renderStats() {
    const stats = this.getStats();
    const data = [
      ["今日", stats.today],
      ["逾期", stats.overdue],
      ["未来7天", stats.week],
      ["未完成", stats.open],
      ["已完成", stats.done],
      ["无日期", stats.inbox],
    ];

    const grid = this.contentEl.createDiv({ cls: "dwp-stats" });
    for (const [label, value] of data) {
      const card = grid.createDiv({ cls: "dwp-stat" });
      card.createEl("strong", { text: String(value) });
      card.createEl("span", { text: label });
    }
  }

  renderControls() {
    const controls = this.contentEl.createDiv({ cls: "dwp-controls" });

    const tabs = controls.createDiv({ cls: "dwp-tabs" });
    [
      ["today", "今日"],
      ["overdue", "逾期"],
      ["week", "未来7天"],
      ["all", "全部"],
      ["done", "已完成"],
      ["inbox", "无日期"],
    ].forEach(([id, label]) => {
      const tab = tabs.createEl("button", { text: label, cls: "dwp-tab" });
      if (this.activeFilter === id) tab.addClass("is-active");
      tab.addEventListener("click", () => {
        this.activeFilter = id;
        this.render();
      });
    });

    const search = controls.createEl("input", {
      type: "search",
      cls: "dwp-search",
      placeholder: "搜索任务或来源",
      value: this.searchText,
    });
    search.addEventListener("input", event => {
      this.searchText = event.target.value;
      this.renderTaskList();
    });
  }

  renderTaskList() {
    this.contentEl.querySelector(".dwp-list")?.remove();

    const list = this.contentEl.createDiv({ cls: "dwp-list" });
    const items = this.getVisibleItems();

    if (!items.length) {
      const empty = list.createDiv({ cls: "dwp-empty" });
      empty.setText("暂无事项");
      return;
    }

    for (const item of items) {
      this.renderItem(list, item);
    }
  }

  renderItem(parent, item) {
    const row = parent.createDiv({ cls: `dwp-row ${item.completed ? "is-done" : ""}` });

    const toggle = row.createEl("button", {
      cls: "dwp-check",
      attr: { title: item.completed ? "恢复未完成" : "标记完成" },
    });
    setIcon(toggle, item.completed ? "rotate-ccw" : "check");
    toggle.addEventListener("click", async event => {
      event.stopPropagation();
      await this.plugin.setItemCompleted(item, !item.completed);
      new Notice(item.completed ? "已恢复为未完成" : "已标记完成");
    });

    const body = row.createDiv({ cls: "dwp-row-body" });
    const title = body.createEl("button", { cls: "dwp-title", text: item.text });
    title.addEventListener("click", () => this.plugin.openFile(item.file, Math.max(item.line - 1, 0)));

    const meta = body.createDiv({ cls: "dwp-meta" });
    this.chip(meta, "计划 " + dateLabel(item.date));
    this.chip(meta, "截止 " + dateLabel(item.due), item.due && this.isOverdue(item) ? "danger" : "");
    this.chip(meta, "优先级 " + item.priority, item.priorityRank === 0 ? "danger" : item.priorityRank === 1 ? "warning" : "");
    if (item.status) this.chip(meta, "状态 " + item.status);
    this.chip(meta, item.file.basename);

    const open = row.createEl("button", {
      cls: "dwp-icon-button",
      attr: { title: "打开来源", "aria-label": "打开来源" },
    });
    setIcon(open, "file-text");
    open.addEventListener("click", event => {
      event.stopPropagation();
      this.plugin.openFile(item.file, Math.max(item.line - 1, 0));
    });
  }

  chip(parent, text, tone = "") {
    const chip = parent.createSpan({ cls: `dwp-chip ${tone}`.trim(), text });
    return chip;
  }

  getVisibleItems() {
    const query = this.searchText.trim().toLowerCase();
    return this.items
      .filter(item => this.matchesFilter(item))
      .filter(item => {
        if (!query) return true;
        return `${item.text} ${item.file.basename} ${item.priority} ${item.status}`.toLowerCase().includes(query);
      })
      .sort((a, b) => this.sortItems(a, b));
  }

  matchesFilter(item) {
    if (this.activeFilter === "today") return !item.completed && this.isToday(item);
    if (this.activeFilter === "overdue") return !item.completed && this.isOverdue(item);
    if (this.activeFilter === "week") return !item.completed && this.isWeek(item);
    if (this.activeFilter === "done") return item.completed;
    if (this.activeFilter === "inbox") return !item.completed && !item.date && !item.due;
    return !item.completed;
  }

  isToday(item) {
    return Boolean(
      (item.date && item.date.isSame(this.today, "day")) ||
        (item.due && item.due.isSame(this.today, "day"))
    );
  }

  isOverdue(item) {
    return Boolean(item.due && item.due.isBefore(this.today, "day"));
  }

  isWeek(item) {
    return Boolean(item.due && item.due.isAfter(this.today, "day") && item.due.isSameOrBefore(this.next7, "day"));
  }

  sortItems(a, b) {
    if (this.activeFilter === "done") {
      return (b.due?.valueOf() || b.date?.valueOf() || b.mtime) - (a.due?.valueOf() || a.date?.valueOf() || a.mtime);
    }

    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;

    const aDate = a.due || a.date;
    const bDate = b.due || b.date;
    if (aDate && bDate && !aDate.isSame(bDate, "day")) return aDate.valueOf() - bDate.valueOf();
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return a.text.localeCompare(b.text, "zh-CN");
  }
}

class NewDailyTaskModal extends Modal {
  constructor(app, plugin, onCreate) {
    super(app);
    this.plugin = plugin;
    this.onCreate = onCreate;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("dwp-modal");
    this.contentEl.createEl("h2", { text: "新增每日事项" });

    const form = this.contentEl.createEl("form", { cls: "dwp-form" });
    const title = this.field(form, "任务内容", "text", "例如：整理今日工作计划");
    const date = this.field(form, "计划日期", "date");
    const startTime = this.field(form, "开始时间", "time");
    const endTime = this.field(form, "结束时间", "time");

    date.value = m()().format("YYYY-MM-DD");
    startTime.value = this.plugin.settings.defaultStartTime;
    endTime.value = this.plugin.settings.defaultEndTime;

    const priorityWrap = form.createDiv({ cls: "dwp-field" });
    priorityWrap.createEl("label", { text: "优先级" });
    const priority = priorityWrap.createEl("select");
    ["高", "中", "低"].forEach(value => {
      const option = priority.createEl("option", { text: value, value });
      if (value === this.plugin.settings.defaultPriority) option.selected = true;
    });

    const footer = form.createDiv({ cls: "dwp-form-footer" });
    const cancel = footer.createEl("button", { text: "取消", type: "button" });
    cancel.addEventListener("click", () => this.close());
    const submit = footer.createEl("button", { text: "创建", type: "submit", cls: "mod-cta" });

    form.addEventListener("submit", async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const file = await this.plugin.createTask({
          title: title.value,
          date: date.value,
          startTime: startTime.value,
          endTime: endTime.value,
          priority: priority.value,
        });
        new Notice("每日事项已创建");
        this.close();
        await this.onCreate(file);
      } catch (error) {
        new Notice(error.message || "创建失败");
        submit.disabled = false;
      }
    });

    title.focus();
  }

  field(parent, label, type, placeholder = "") {
    const wrap = parent.createDiv({ cls: "dwp-field" });
    wrap.createEl("label", { text: label });
    return wrap.createEl("input", { type, placeholder });
  }
}

class DailyWorkPlanSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "每日工作计划" });

    new Setting(containerEl)
      .setName("数据目录")
      .setDesc("插件会读取这个目录下的 Markdown 文件。")
      .addText(text => {
        text
          .setPlaceholder("所有笔记/待办事项/每日事项")
          .setValue(this.plugin.settings.sourceFolder)
          .onChange(async value => {
            this.plugin.settings.sourceFolder = normalizeFolder(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("默认优先级")
      .addDropdown(dropdown => {
        ["高", "中", "低"].forEach(value => dropdown.addOption(value, value));
        dropdown.setValue(this.plugin.settings.defaultPriority);
        dropdown.onChange(async value => {
          this.plugin.settings.defaultPriority = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认开始时间")
      .addText(text => {
        text.setPlaceholder("09:00").setValue(this.plugin.settings.defaultStartTime);
        text.onChange(async value => {
          this.plugin.settings.defaultStartTime = value || DEFAULT_SETTINGS.defaultStartTime;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认结束时间")
      .addText(text => {
        text.setPlaceholder("18:00").setValue(this.plugin.settings.defaultEndTime);
        text.onChange(async value => {
          this.plugin.settings.defaultEndTime = value || DEFAULT_SETTINGS.defaultEndTime;
          await this.plugin.saveSettings();
        });
      });
  }
}

module.exports = DailyWorkPlanPlugin;
