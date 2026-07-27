// スプレッドシートとの入出力。行 ⇄ タスクの変換と、接続方式ごとのアダプタ。
// 画面側は SheetsProvider の4つのメソッドしか知らないので、
// 接続方式が決まったらこのファイルだけを差し替えれば済む（要件7.4 保守性）。
//
// 対応する要件: 3.3 / 4.9 Googleスプレッドシートとの同期 / 6.1 データモデル

const SHEET_FIELDS = [
  "id",
  "projectId",
  "title",
  "description",
  "status",
  "confirmation",
  "priority",
  "importance",
  "urgency",
  "effort",
  "deadline",
  "executor",
  "autonomy",
  "blockedBy",
  "nextAction",
  "definitionOfDone",
  "sources",
  "updated",
  "aiExtracted",
  "aiGenerated",
  "aiEstimatedFields",
  "confirmedFields",
  "createdAt",
  "updatedAt",
  "completedAt",
  "archivedAt",
  "version",
];

const PROJECT_FIELDS = [
  "id",
  "parentId",
  "name",
  "category",
  "activity",
  "status",
  "phase",
  "priority",
  "progress",
  "taskCount",
  "nextAction",
  "blockedBy",
  "autonomy",
  "updated",
  "source",
];

const ARRAY_FIELDS = new Set(["sources", "aiEstimatedFields", "confirmedFields", "blockedBy"]);
const BOOLEAN_FIELDS = new Set(["aiExtracted", "aiGenerated"]);

// スプレッドシートが管理し、アプリからは触らない列。
// GAS側と同じ約束にしておく（`_AI/scripts/ai_todo_sync.gs` の SERVER_OWNED）。
const NEVER_OVERWRITE = new Set(["createdAt"]);

// 見出し行が想定と違うシートに書き込むと、列がずれて正本を壊す。
// 読み込みの時点で気づけるよう、必須列が無ければ例外にする。
class SchemaMismatchError extends Error {
  constructor(missing, header) {
    super(
      `シートの見出し行が想定と違います。見つからない列: ${missing.join(", ")}\n` +
      `実際の見出し: ${header.filter(Boolean).join(", ") || "（空）"}\n` +
      `js/config.js の columns と、実際のシートのどちらが正しいか確認してください。`
    );
    this.name = "SchemaMismatchError";
    this.missing = missing;
    this.header = header;
  }
}

function headerRow(config = APP_CONFIG) {
  return SHEET_FIELDS.map((f) => config.columns[f] || f);
}

function encodeArray(value, config = APP_CONFIG) {
  const arr = Array.isArray(value) ? value : [];
  if (arr.length === 0) return "";
  return config.arrayEncoding === "delimited" ? arr.join(config.arrayDelimiter) : JSON.stringify(arr);
}

function decodeArray(raw, config = APP_CONFIG) {
  if (raw == null) return [];
  const text = String(raw).trim();
  if (text === "") return [];
  if (config.arrayEncoding === "delimited") {
    return text.split(config.arrayDelimiter).map((s) => s.trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    // JSONとして読めない値でも捨てずに、1件の文字列として拾う。
    return [text];
  }
}

function taskToRow(task, config = APP_CONFIG) {
  return SHEET_FIELDS.map((field) => {
    const value = task[field];
    if (ARRAY_FIELDS.has(field)) return encodeArray(value, config);
    if (BOOLEAN_FIELDS.has(field)) return value ? "TRUE" : "FALSE";
    if (value == null) return "";
    return String(value);
  });
}

// 見出し行を手がかりに列位置を解決する。列の並び替えに強くするため、
// 位置ではなく見出し文字列で対応づける。
function buildColumnIndex(header, config = APP_CONFIG, fields = SHEET_FIELDS, map = null) {
  const columns = map || config.columns;
  const normalized = header.map((h) => String(h || "").trim());
  const index = {};
  fields.forEach((field) => {
    const name = columns[field] || field;
    const at = normalized.indexOf(name);
    if (at >= 0) index[field] = at;
  });
  return index;
}

function decodeCells(row, columnIndex, fields, config) {
  const partial = {};
  fields.forEach((field) => {
    const at = columnIndex[field];
    if (at == null) return;
    const raw = row[at];
    if (ARRAY_FIELDS.has(field)) {
      partial[field] = decodeArray(raw, config);
    } else if (BOOLEAN_FIELDS.has(field)) {
      partial[field] = String(raw).trim().toUpperCase() === "TRUE";
    } else if (field === "version") {
      partial[field] = raw === "" || raw == null ? 1 : Number(raw);
    } else {
      partial[field] = raw == null || raw === "" ? null : String(raw);
    }
  });
  return partial;
}

function rowToTask(row, columnIndex, config = APP_CONFIG) {
  const task = makeTask(decodeCells(row, columnIndex, SHEET_FIELDS, config));
  // 保存を行単位で行うために、由来の行をそのまま覚えておく。
  // これがあると、アプリが知らない列を消さずに書き戻せる。
  Object.defineProperty(task, "_raw", { value: row.slice(), enumerable: false, writable: true });

  // 空欄だった列を覚えておく。
  // シート側の空欄は「未設定」ではなく「AIがまだ推定していない」を表すことがある
  // （GASは AI仮説 の列を空にして aiEstimatedFields に列名を入れる）。
  // makeTask が既定値で埋めた値をそのまま書き戻すと、その区別が消える。
  const blanks = new Set();
  SHEET_FIELDS.forEach((field) => {
    const at = columnIndex[field];
    if (at != null && String(row[at] == null ? "" : row[at]).trim() === "") blanks.add(field);
  });
  Object.defineProperty(task, "_blank", { value: blanks, enumerable: false, writable: true });
  return task;
}

// makeTask が入れる既定値。書き戻しの判定に使う。
let DEFAULTS = null;
function defaultsOf() {
  if (!DEFAULTS) DEFAULTS = makeTask({ title: "x" });
  return DEFAULTS;
}

function rowToProject(row, columnIndex, config = APP_CONFIG) {
  return makeProject(decodeCells(row, columnIndex, PROJECT_FIELDS, config));
}

// 見出し行が欠けている・足りない場合に、どの列が無いのかを返す。
function missingColumns(header, config = APP_CONFIG) {
  const index = buildColumnIndex(header, config);
  return SHEET_FIELDS.filter((f) => index[f] == null).map((f) => config.columns[f] || f);
}

// 必須列だけを見て、書き込んでよいシートかを判定する。
// 任意列の不足は警告で済ませるが、ここに挙げた列が無ければ処理を止める。
function assertSchema(header, config = APP_CONFIG) {
  const index = buildColumnIndex(header, config);
  const required = config.requiredColumns || ["id", "title", "status"];
  const missing = required.filter((f) => index[f] == null).map((f) => config.columns[f] || f);
  if (missing.length > 0) throw new SchemaMismatchError(missing, header);
  return index;
}

// 版番号による競合検出（要件4.9）。読み込み時より新しくなっていたら衝突とみなす。
function detectConflicts(localTasks, remoteTasks, field = "version") {
  const remote = new Map(remoteTasks.map((t) => [t.id, t]));
  const conflicts = [];
  localTasks.forEach((local) => {
    const base = local.baseVersion != null ? local.baseVersion : local[field];
    const server = remote.get(local.id);
    if (!server) return;
    if (Number(server[field]) > Number(base)) {
      conflicts.push({ id: local.id, title: local.title, local, remote: server });
    }
  });
  return conflicts;
}

// 読み書きするタブ名を決める。設定した名前が無ければ先頭のタブで代用する
// （CSVから作ったシートはタブ名がファイル名になることがあるため）。
// 代用したかどうかを呼び出し側へ返し、画面で知らせられるようにする。
async function resolveTabName(config, listTabTitles, wanted = config.sheets.tabName) {
  const titles = await listTabTitles();
  if (titles.includes(wanted)) return { tabName: wanted, substituted: false };

  if (!config.sheets.fallbackToFirstTab) {
    throw new Error(
      `「${wanted}」タブが見つかりません（あるタブ: ${titles.join(", ") || "なし"}）。\n` +
      `別のタブで代用すると列がずれて壊れるため、処理を中止しました。`
    );
  }
  if (titles.length === 0) throw new Error("スプレッドシートにタブが1つもありません");
  return { tabName: titles[0], substituted: true };
}

// 0始まりの列番号を A1 記法の列名にする（0 -> A、26 -> AA）。
function columnLetter(index) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// 既存行を書き戻す1行分を作る。元の行をそのまま土台にし、
// アプリが扱う列だけを差し替える。知らない列は触らない。
function mergeRow(task, columnIndex, config = APP_CONFIG) {
  const width = Math.max(
    ...Object.values(columnIndex).map((i) => i + 1),
    (task._raw || []).length
  );
  const row = new Array(width).fill("");
  (task._raw || []).forEach((v, i) => { row[i] = v == null ? "" : v; });

  const blanks = task._blank || new Set();
  const defaults = defaultsOf();
  const untouched = new Set(task.confirmedFields || []);

  SHEET_FIELDS.forEach((field) => {
    const at = columnIndex[field];
    if (at == null) return;
    if (NEVER_OVERWRITE.has(field)) return;
    const value = task[field];

    // もとが空欄で、本人も触っていない（＝makeTaskの既定値のまま）なら空欄で戻す。
    // 既定値を書き込むと「AIがまだ推定していない」という情報が消えるため。
    if (blanks.has(field) && !untouched.has(field) && value === defaults[field]) {
      row[at] = "";
      return;
    }

    if (ARRAY_FIELDS.has(field)) row[at] = encodeArray(value, config);
    else if (BOOLEAN_FIELDS.has(field)) row[at] = value ? "TRUE" : "FALSE";
    else row[at] = value == null ? "" : String(value);
  });
  return row;
}

function valuesUrl(spreadsheetId, tabName) {
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(tabName)}`
  );
}

function metaUrl(spreadsheetId) {
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `?fields=sheets.properties.title`
  );
}

function tabTitlesFrom(body) {
  return (body.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
}

// ---- アダプタ ----
// どの実装も load() / save() / isWritable() / describe() を持つ。

// 未接続。ブラウザ内の下書きだけで動く。MVPの受け入れ条件3〜8は満たさない。
const LocalDraftProvider = {
  key: "local",
  isWritable: () => true,
  describe: () => "未接続（ブラウザ内の下書き）",
  async load() {
    try {
      const raw = localStorage.getItem("mvp_draft_tasks");
      const rows = raw ? JSON.parse(raw) : [];
      return { tasks: rows.map((r) => makeTask(r)), warnings: [] };
    } catch {
      return { tasks: [], warnings: ["下書きデータを読めなかったため空で開始しました"] };
    }
  },
  async save(tasks) {
    localStorage.setItem("mvp_draft_tasks", JSON.stringify(tasks));
    return { savedCount: tasks.length, conflicts: [] };
  },
};

// APIキーによる読み取り専用。書き込みはGoogleの仕様上できない。
const GoogleSheetsReadOnlyProvider = {
  key: "apiKey",
  isWritable: () => false,
  describe: () => "Googleスプレッドシート（読み取りのみ）",
  async load(config = APP_CONFIG) {
    const { spreadsheetId, apiKey } = config.sheets;
    if (!apiKey) throw new Error("APIキーが設定されていません（js/config.js の sheets.apiKey）");
    const key = `key=${encodeURIComponent(apiKey)}`;

    const { tabName, substituted } = await resolveTabName(config, async () => {
      const res = await fetch(`${metaUrl(spreadsheetId)}&${key}`);
      if (!res.ok) throw new Error(`スプレッドシートを開けませんでした（${res.status}）`);
      return tabTitlesFrom(await res.json());
    });

    const res = await fetch(`${valuesUrl(spreadsheetId, tabName)}?${key}`);
    if (!res.ok) throw new Error(`スプレッドシートを読めませんでした（${res.status}）`);
    const result = parseValues((await res.json()).values || [], config);
    result.projects = [];
    if (substituted) {
      result.warnings.push(`「${config.sheets.tabName}」タブが無いため「${tabName}」を読みました`);
    }
    return result;
  },
  async save() {
    throw new Error("APIキー方式では書き込みできません。OAuth接続に切り替えてください");
  },
};

// OAuthによる読み書き。MVPを満たすにはこれが必要（要件4.9 / 9章の3〜8）。
// 認証トークンの取得方法は未決のため、getAccessToken を差し替え口として空けてある。
const GoogleSheetsProvider = {
  key: "oauth",
  isWritable: () => true,
  describe: () => "Googleスプレッドシート（読み書き）",

  // 要決定: トークンの取得方式（Google Identity Services / サーバー経由 など）。
  // 認証情報をフロントに埋め込まないこと（要件7.3）。
  async getAccessToken() {
    if (typeof window !== "undefined" && typeof window.getSheetsAccessToken === "function") {
      return window.getSheetsAccessToken();
    }
    throw new Error("アクセストークンの取得方法が未設定です（js/sheets.js の getAccessToken）");
  },

  async resolveTab(config, token) {
    const { spreadsheetId } = config.sheets;
    return resolveTabName(config, async () => {
      const res = await fetch(metaUrl(spreadsheetId), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`スプレッドシートを開けませんでした（${res.status}）`);
      return tabTitlesFrom(await res.json());
    });
  },

  async load(config = APP_CONFIG) {
    const token = await this.getAccessToken();
    const { spreadsheetId } = config.sheets;
    const auth = { Authorization: `Bearer ${token}` };
    const titles = await this.tabTitles(config, token);

    const { tabName } = await resolveTabName(config, async () => titles);
    const res = await fetch(valuesUrl(spreadsheetId, tabName), { headers: auth });
    if (!res.ok) throw new Error(`スプレッドシートを読めませんでした（${res.status}）`);
    const result = parseValues((await res.json()).values || [], config);
    result.tabName = tabName;

    // 大タスクは読めたら使う。無くても小タスクの表示は続けられるようにする。
    result.projects = [];
    const projectsTab = config.sheets.projectsTabName;
    if (projectsTab && titles.includes(projectsTab)) {
      const pres = await fetch(valuesUrl(spreadsheetId, projectsTab), { headers: auth });
      if (pres.ok) {
        const parsed = parseProjectValues((await pres.json()).values || [], config);
        result.projects = parsed.projects;
        result.warnings.push(...parsed.warnings);
      } else {
        result.warnings.push(`「${projectsTab}」を読めませんでした（${pres.status}）`);
      }
    } else if (projectsTab) {
      result.warnings.push(`「${projectsTab}」タブが無いため、大タスクの情報なしで表示します`);
    }
    return result;
  },

  async tabTitles(config, token) {
    const res = await fetch(metaUrl(config.sheets.spreadsheetId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`スプレッドシートを開けませんでした（${res.status}）`);
    return tabTitlesFrom(await res.json());
  },

  // 行単位で更新する。以前はタブ全体をPUTで置き換えていたが、
  // 列の対応が1つでもずれると正本を丸ごと壊すため、変更のあった行だけを書く。
  // アプリが知らない列は元の値をそのまま書き戻す。
  async save(tasks, config = APP_CONFIG) {
    const token = await this.getAccessToken();
    const { spreadsheetId } = config.sheets;

    // 保存前に現在の内容を読み、版番号で競合を確認する（要件4.9）。
    const current = await this.load(config);
    const conflicts = detectConflicts(tasks, current.tasks, config.behavior.conflictField);
    if (conflicts.length > 0) return { savedCount: 0, conflicts };

    const tabName = current.tabName;
    // まっさらなシートなら、まず見出し行を作る。ここだけは全面書き込みでよい
    // （既存データが無いので壊すものがない）。
    let columnIndex = current.columnIndex;
    if (current.isEmpty) {
      const header = headerRow(config);
      const res = await fetch(`${valuesUrl(spreadsheetId, tabName)}?valueInputOption=RAW`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [header] }),
      });
      if (!res.ok) throw new Error(`見出し行を作れませんでした（${res.status}）`);
      columnIndex = buildColumnIndex(header, config);
    }

    const rowById = new Map(current.tasks.map((t) => [t.id, t._row]));
    const rawById = new Map(current.tasks.map((t) => [t.id, t._raw]));

    const updates = [];
    const appends = [];
    tasks.forEach((task) => {
      const row = rowById.get(task.id);
      if (!task._raw && rawById.has(task.id)) task._raw = rawById.get(task.id);
      const values = mergeRow(task, columnIndex, config);
      if (row) {
        const last = columnLetter(values.length - 1);
        updates.push({ range: `${tabName}!A${row}:${last}${row}`, values: [values] });
      } else {
        appends.push(values);
      }
    });

    if (updates.length > 0) {
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
        }
      );
      if (!res.ok) throw new Error(`保存に失敗しました（${res.status}）`);
    }

    if (appends.length > 0) {
      const res = await fetch(
        `${valuesUrl(spreadsheetId, tabName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: appends }),
        }
      );
      if (!res.ok) throw new Error(`追加に失敗しました（${res.status}）`);
    }

    return { savedCount: updates.length + appends.length, conflicts: [] };
  },
};

function parseValues(values, config = APP_CONFIG) {
  const headerIndex = (config.sheets.headerRow || 1) - 1;
  const header = values[headerIndex] || [];
  const warnings = [];

  // まっさらなシートは誤読のしようがないので通す。保存時に見出し行から作る。
  const isEmpty = header.every((cell) => String(cell || "").trim() === "");
  if (isEmpty) {
    return { tasks: [], warnings, header: [], columnIndex: {}, isEmpty: true };
  }

  // 必須列が無ければここで止まる。列がずれたまま読み進めると、
  // IDを見失って別タスクとして書き戻してしまう。
  const columnIndex = assertSchema(header, config);

  const missing = missingColumns(header, config);
  if (missing.length > 0) {
    warnings.push(`見出し行に見つからない列があります: ${missing.join(", ")}（その列は空として扱います）`);
  }

  const tasks = [];
  values.slice(headerIndex + 1).forEach((row, offset) => {
    if (!row.some((cell) => String(cell || "").trim() !== "")) return;
    const task = rowToTask(row, columnIndex, config);
    // シート上の実際の行番号（1始まり）。行単位の更新に使う。
    Object.defineProperty(task, "_row", {
      value: headerIndex + 2 + offset,
      enumerable: false,
      writable: true,
    });
    tasks.push(task);
  });
  return { tasks, warnings, header, columnIndex };
}

function parseProjectValues(values, config = APP_CONFIG) {
  const headerIndex = (config.sheets.headerRow || 1) - 1;
  const header = values[headerIndex] || [];
  const columnIndex = buildColumnIndex(header, config, PROJECT_FIELDS, config.projectColumns);
  if (columnIndex.id == null) {
    return { projects: [], warnings: ["Projectsシートに project_id 列が見つかりません"] };
  }
  const projects = values
    .slice(headerIndex + 1)
    .filter((row) => String(row[columnIndex.id] || "").trim() !== "")
    .map((row) => rowToProject(row, columnIndex, config));
  return { projects, warnings: [] };
}

function selectProvider(config = APP_CONFIG) {
  if (config.sheets.authMode === "oauth") return GoogleSheetsProvider;
  if (config.sheets.authMode === "apiKey") return GoogleSheetsReadOnlyProvider;
  return LocalDraftProvider;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHEET_FIELDS,
    PROJECT_FIELDS,
    SchemaMismatchError,
    headerRow,
    taskToRow,
    rowToTask,
    rowToProject,
    mergeRow,
    columnLetter,
    buildColumnIndex,
    missingColumns,
    assertSchema,
    detectConflicts,
    parseValues,
    parseProjectValues,
    resolveTabName,
    tabTitlesFrom,
    selectProvider,
    LocalDraftProvider,
    GoogleSheetsProvider,
    GoogleSheetsReadOnlyProvider,
  };
}
