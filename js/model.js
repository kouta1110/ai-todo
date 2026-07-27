// タスクのデータ構造と、並び替え・絞り込みの規則。
// 画面にも通信にも依存しないので、そのままテストできる。
// 対応する要件: 4.3 タスク分類 / 4.4 一覧 / 4.5 絞り込み・並び替え / 6.1 データモデル

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

// Obsidianの状態語彙をそのまま使う（`タスク/フォーマット.md`）。
const OPEN_STATUSES = ["未着手", "進行中", "保留"];
const CLOSED_STATUSES = ["完了", "キャンセル"];

function isOpen(task) {
  return OPEN_STATUSES.includes(task.status);
}
function isDone(task) {
  return task.status === "完了";
}
function isArchived(task) {
  return task.status === "キャンセル" || Boolean(task.archivedAt);
}

function generateId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  if (Array.isArray(value)) return value.slice();
  if (value == null || value === "") return [];
  return [value];
}

// 欠けた項目を既定値で埋め、型を揃える。スプレッドシート由来の値は
// すべて文字列で来るため、ここで正規化してから画面とロジックへ渡す。
function makeTask(partial = {}) {
  const created = partial.createdAt || nowIso();
  return {
    id: partial.id || generateId(),
    projectId: partial.projectId || null,
    title: (partial.title || "").trim(),
    description: partial.description || "",
    status: partial.status || "未着手",
    confirmation: partial.confirmation || "confirmed",
    priority: partial.priority || "medium",
    importance: partial.importance || "medium",
    urgency: partial.urgency || null,
    effort: partial.effort || "medium",
    deadline: partial.deadline || null,
    executor: partial.executor || "本人",
    autonomy: partial.autonomy || "",
    blockedBy: toArray(partial.blockedBy),
    nextAction: partial.nextAction || "",
    definitionOfDone: partial.definitionOfDone || "",
    sources: toArray(partial.sources),
    updated: partial.updated || "",
    aiExtracted: Boolean(partial.aiExtracted),
    aiGenerated: Boolean(partial.aiGenerated),
    aiEstimatedFields: toArray(partial.aiEstimatedFields),
    confirmedFields: toArray(partial.confirmedFields),
    createdAt: created,
    updatedAt: partial.updatedAt || created,
    completedAt: partial.completedAt || null,
    archivedAt: partial.archivedAt || null,
    version: Number.isFinite(Number(partial.version)) ? Number(partial.version) : 1,
  };
}

// 大タスク。Obsidianの `_概要.md` が正本で、アプリからは書き込まない。
function makeProject(partial = {}) {
  return {
    id: partial.id || "",
    parentId: partial.parentId || null,
    name: partial.name || "",
    category: partial.category || "",
    activity: partial.activity || "",
    status: partial.status || "候補",
    phase: partial.phase || "",
    priority: partial.priority || "",
    progress: partial.progress === "" || partial.progress == null ? null : Number(partial.progress),
    taskCount: Number(partial.taskCount) || 0,
    nextAction: partial.nextAction || "",
    blockedBy: toArray(partial.blockedBy),
    autonomy: partial.autonomy || "",
    updated: partial.updated || "",
    source: partial.source || "",
  };
}

function validateTask(task) {
  const errors = [];
  if (!task.title || !task.title.trim()) errors.push("タスク名を入力してください");
  if (task.deadline && Number.isNaN(new Date(task.deadline).getTime())) {
    errors.push("期限の形式が正しくありません");
  }
  return errors;
}

// 本人が触った項目を confirmedFields に積む（要件6.3 手動修正の保護）。
// AI更新はこの一覧に載っている項目を上書きしない。
function applyEdit(task, changes) {
  const next = { ...task };
  const confirmed = new Set(task.confirmedFields);
  Object.entries(changes).forEach(([key, value]) => {
    if (next[key] === value) return;
    next[key] = value;
    confirmed.add(key);
  });
  next.confirmedFields = [...confirmed];
  next.updatedAt = nowIso();
  return next;
}

function completeTask(task) {
  return { ...task, status: "完了", completedAt: nowIso(), updatedAt: nowIso() };
}

function reopenTask(task) {
  return { ...task, status: "未着手", completedAt: null, archivedAt: null, updatedAt: nowIso() };
}

// 物理削除ではなくアーカイブで代替する（要件4.8）。
// アーカイブ済みであることをスプレッドシートに残すので、次回のAI更新で同じ内容が復活しない。
// Obsidian側に「アーカイブ」という状態は無いので、`キャンセル` に寄せたうえで
// `archivedAt` で区別する（GASの移行マッピングと同じ扱い）。
function archiveTask(task) {
  return { ...task, status: "キャンセル", archivedAt: nowIso(), updatedAt: nowIso() };
}

// 本人が確定した項目はAI更新で上書きしない（要件4.10 / 6.3）。
// 上書きできなかった値は pendingProposal として別に保持し、後から確認できるようにする。
function mergeAiUpdate(current, incoming) {
  const protectedFields = new Set(current.confirmedFields);
  const merged = { ...current };
  const rejected = {};
  Object.entries(incoming).forEach(([key, value]) => {
    if (["id", "createdAt", "confirmedFields", "version"].includes(key)) return;
    if (protectedFields.has(key)) {
      if (current[key] !== value) rejected[key] = value;
      return;
    }
    merged[key] = value;
  });
  if (CLOSED_STATUSES.includes(current.status) || current.archivedAt) {
    merged.status = current.status;
    merged.completedAt = current.completedAt;
    merged.archivedAt = current.archivedAt;
  }
  merged.pendingProposal = Object.keys(rejected).length > 0 ? rejected : null;
  merged.updatedAt = nowIso();
  return merged;
}

// ---- 並び替え ----

function deadlineValue(task) {
  if (!task.deadline) return null;
  const t = new Date(task.deadline).getTime();
  return Number.isNaN(t) ? null : t;
}

// 既定は期限の近い順（要件4.5）。期限なしの置き場所は設定で切り替える
// （要件10「期限なしタスクを期限順一覧のどこに配置するか」が未決のため）。
function sortTasks(tasks, options = {}) {
  const noDeadlinePosition = options.noDeadlinePosition || "last";
  const withDeadline = [];
  const withoutDeadline = [];
  tasks.forEach((t) => (deadlineValue(t) == null ? withoutDeadline : withDeadline).push(t));

  withDeadline.sort((a, b) => {
    const diff = deadlineValue(a) - deadlineValue(b);
    if (diff !== 0) return diff;
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  });
  withoutDeadline.sort((a, b) => {
    const diff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (diff !== 0) return diff;
    return (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3);
  });

  return noDeadlinePosition === "first"
    ? [...withoutDeadline, ...withDeadline]
    : [...withDeadline, ...withoutDeadline];
}

// ---- 絞り込み ----

// AIが推定または生成した項目のうち、本人がまだ確認していないものがあるか（要件4.4）。
function hasUnconfirmedAi(task) {
  if (task.aiGenerated && task.confirmation === "proposed") return true;
  return task.aiEstimatedFields.some((f) => !task.confirmedFields.includes(f));
}

function isOverdue(task, now = new Date()) {
  const d = deadlineValue(task);
  return d != null && d < now.getTime();
}

function daysUntilDeadline(task, now = new Date()) {
  const d = deadlineValue(task);
  if (d == null) return null;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((startOfDay(new Date(d)) - startOfDay(now)) / 86400000);
}

function filterTasks(tasks, filters = {}, now = new Date()) {
  return tasks.filter((task) => {
    if (filters.status && task.status !== filters.status) return false;
    if (filters.open && !isOpen(task)) return false;
    if (filters.confirmation && task.confirmation !== filters.confirmation) return false;
    if (filters.projectId && task.projectId !== filters.projectId) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.importance && task.importance !== filters.importance) return false;
    if (filters.effort && task.effort !== filters.effort) return false;
    if (filters.executor && task.executor !== filters.executor) return false;
    if (filters.hasDeadline && !task.deadline) return false;
    if (filters.urgentOnly && task.urgency !== "high" && !isOverdue(task, now)) return false;
    if (filters.aiUnconfirmedOnly && !hasUnconfirmedAi(task)) return false;
    if (filters.keyword) {
      const kw = filters.keyword.toLowerCase();
      const hay = `${task.title} ${task.description}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

// 一覧を日付の見出しごとにまとめる。期限の流れが見えるようにするため（要件1.2 / 4.4）。
function groupByDeadline(tasks, now = new Date()) {
  const groups = [];
  const index = new Map();
  tasks.forEach((task) => {
    const days = daysUntilDeadline(task, now);
    let key;
    let label;
    if (days == null) {
      key = "none";
      label = "期限なし";
    } else if (days < 0) {
      key = "overdue";
      label = "期限切れ";
    } else {
      const d = new Date(task.deadline);
      key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (days === 0) label = "今日";
      else if (days === 1) label = "明日";
      else label = `${d.getMonth() + 1}/${d.getDate()}（${"日月火水木金土"[d.getDay()]}）`;
    }
    if (!index.has(key)) {
      const group = { key, label, days, tasks: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).tasks.push(task);
  });
  return groups;
}

// ---- 分類フォルダ（Obsidianのフォルダ構造の再現） ----

// Projectsの `category` は深さがまちまち（"A-就活" / "趣味/新規事業立案/営業支援AI"）。
// 先頭の区切りまでを分類フォルダとして扱い、残りは中間パスとして持つ。
function splitCategory(category) {
  const parts = String(category || "").split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { folder: "未分類", rest: [] };
  return { folder: parts[0], rest: parts.slice(1) };
}

// 分類フォルダ → 大タスク → 小タスク の3階層を組む。
// 小タスクは projectId で大タスクへ、大タスクは category で分類へぶら下げる。
// projectId が解決できない小タスクは捨てずに「所属不明」へ集める。
function buildFolderTree(tasks, projects, options = {}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const folders = [];
  const folderIndex = new Map();

  const folderFor = (name) => {
    if (!folderIndex.has(name)) {
      const f = { key: name, label: name, projects: [], taskCount: 0, openCount: 0 };
      folderIndex.set(name, f);
      folders.push(f);
    }
    return folderIndex.get(name);
  };

  const groupIndex = new Map();
  const groupFor = (project, folderName, path) => {
    if (!groupIndex.has(project.id)) {
      const g = { project, path, tasks: [] };
      groupIndex.set(project.id, g);
      folderFor(folderName).projects.push(g);
    }
    return groupIndex.get(project.id);
  };

  tasks.forEach((task) => {
    const project = byId.get(task.projectId);
    if (project) {
      const { folder, rest } = splitCategory(project.category);
      groupFor(project, folder, rest).tasks.push(task);
    } else {
      const placeholder = { id: `__unknown__${task.projectId || ""}`, name: task.projectId || "所属なし" };
      groupFor(placeholder, "所属不明", []).tasks.push(task);
    }
  });

  folders.forEach((f) => {
    f.projects.forEach((g) => {
      f.taskCount += g.tasks.length;
      f.openCount += g.tasks.filter(isOpen).length;
    });
  });

  if (options.hideEmpty !== false) {
    return folders.filter((f) => f.taskCount > 0);
  }
  return folders;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    generateId,
    makeTask,
    makeProject,
    validateTask,
    applyEdit,
    completeTask,
    reopenTask,
    archiveTask,
    mergeAiUpdate,
    sortTasks,
    filterTasks,
    groupByDeadline,
    buildFolderTree,
    splitCategory,
    hasUnconfirmedAi,
    isOpen,
    isDone,
    isArchived,
    isOverdue,
    daysUntilDeadline,
    OPEN_STATUSES,
    CLOSED_STATUSES,
  };
}
