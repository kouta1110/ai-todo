// 画面が参照する状態と、その更新手段。
// 変更は自動保存せず、未保存のまま溜めて「更新」でまとめて反映する（要件4.9）。

const SYNC_STATES = {
  idle: "読み込み前",
  loading: "読み込み中",
  loaded: "最新",
  dirty: "未保存の変更あり",
  saving: "更新中",
  saved: "更新済み",
  error: "更新失敗",
};

const store = {
  tasks: [],
  // 読み込んだ時点の版番号。保存時の競合検出に使う。
  baseVersions: new Map(),
  syncState: "idle",
  message: "",
  warnings: [],
  conflicts: [],
  lastLoadedAt: null,
  lastSavedAt: null,
  lastAiUpdateAt: null,
  provider: null,
  listeners: [],
};

function subscribe(fn) {
  store.listeners.push(fn);
}

function emit() {
  store.listeners.forEach((fn) => fn(store));
}

function setSync(state, message = "") {
  store.syncState = state;
  store.message = message;
  emit();
}

function isDirty() {
  return store.syncState === "dirty";
}

function markDirty() {
  store.syncState = "dirty";
  store.message = "";
  emit();
}

function getTask(id) {
  return store.tasks.find((t) => t.id === id) || null;
}

function replaceTask(next) {
  const at = store.tasks.findIndex((t) => t.id === next.id);
  if (at >= 0) store.tasks[at] = next;
  else store.tasks.push(next);
  markDirty();
}

// 入力のうち「既定値から変わったもの」だけを確定項目として返す。
function collectConfirmedFields(partial, task) {
  const defaults = makeTask({});
  return Object.keys(partial).filter((key) => {
    if (key === "id") return false;
    if (key === "title") return true; // 必須項目なので、必ず本人が決めている
    return task[key] !== defaults[key];
  });
}

function addTask(partial) {
  const task = makeTask(partial);
  const errors = validateTask(task);
  if (errors.length > 0) return { ok: false, errors };
  // 本人が直接入力したタスクは、出典と確定区分をそこに合わせる（要件4.7 / 6.2）。
  task.sources = ["本人による直接入力"];
  task.decisionStatus = "confirmed";
  // [変更] 既定値のまま保存した項目まで確定扱いにすると、AI同期が一切
  // 上書きできなくなる（期限を空のまま追加したタスクにAIが期限を推定できない）。
  // 実際に既定値から変えた項目だけを確定とする。タスク名は必ず本人が入力するので常に確定。
  task.confirmedFields = collectConfirmedFields(partial, task);
  store.tasks.push(task);
  markDirty();
  return { ok: true, task };
}

function editTask(id, changes) {
  const task = getTask(id);
  if (!task) return { ok: false, errors: ["タスクが見つかりません"] };
  const next = applyEdit(task, changes);
  const errors = validateTask(next);
  if (errors.length > 0) return { ok: false, errors };
  replaceTask(next);
  return { ok: true, task: next };
}

function setStatus(id, action) {
  const task = getTask(id);
  if (!task) return { ok: false, errors: ["タスクが見つかりません"] };
  const next =
    action === "done" ? completeTask(task) : action === "archived" ? archiveTask(task) : reopenTask(task);
  replaceTask(next);
  return { ok: true, task: next };
}

// AI提案を本人が採用する。採用した時点で確定タスクに変わる（要件4.3）。
function confirmProposal(id) {
  const task = getTask(id);
  if (!task) return { ok: false, errors: ["タスクが見つかりません"] };
  const next = {
    ...task,
    decisionStatus: "confirmed",
    confirmedFields: [...new Set([...task.confirmedFields, ...task.aiEstimatedFields])],
    updatedAt: new Date().toISOString(),
  };
  replaceTask(next);
  return { ok: true, task: next };
}

async function load() {
  setSync("loading");
  try {
    const result = await store.provider.load(APP_CONFIG);
    store.tasks = result.tasks;
    store.warnings = result.warnings || [];
    store.baseVersions = new Map(result.tasks.map((t) => [t.id, t.version]));
    store.lastLoadedAt = new Date();
    store.conflicts = [];
    setSync("loaded");
    return { ok: true };
  } catch (err) {
    setSync("error", err.message);
    return { ok: false, error: err.message };
  }
}

// 保存に失敗しても未保存の変更を捨てない（要件4.9 / 7.2）。
async function save() {
  if (!store.provider.isWritable()) {
    setSync("error", "この接続方式では書き込みできません");
    return { ok: false };
  }
  setSync("saving");
  try {
    const payload = store.tasks.map((t) => ({
      ...t,
      baseVersion: store.baseVersions.get(t.id) ?? t.version,
      version: Number(t.version) + 1,
    }));
    const result = await store.provider.save(payload, APP_CONFIG);
    if (result.conflicts && result.conflicts.length > 0) {
      store.conflicts = result.conflicts;
      setSync("error", `他の場所で更新されたタスクがあります（${result.conflicts.length}件）`);
      return { ok: false, conflicts: result.conflicts };
    }
    store.tasks = payload.map(({ baseVersion, ...t }) => t);
    store.baseVersions = new Map(store.tasks.map((t) => [t.id, t.version]));
    store.lastSavedAt = new Date();
    store.conflicts = [];
    setSync("saved");
    return { ok: true };
  } catch (err) {
    // 失敗しても store.tasks はそのまま。もう一度「更新」を押せば再試行できる。
    setSync("error", err.message);
    return { ok: false, error: err.message };
  }
}

function init(provider) {
  store.provider = provider;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    store,
    SYNC_STATES,
    init,
    subscribe,
    load,
    save,
    isDirty,
    markDirty,
    getTask,
    addTask,
    editTask,
    setStatus,
    confirmProposal,
  };
}
