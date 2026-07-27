// スプレッドシートとの入出力。行 ⇄ タスクの変換と、接続方式ごとのアダプタ。
// 画面側は SheetsProvider の4つのメソッドしか知らないので、
// 接続方式が決まったらこのファイルだけを差し替えれば済む（要件7.4 保守性）。
//
// 対応する要件: 3.3 / 4.9 Googleスプレッドシートとの同期 / 6.1 データモデル

const SHEET_FIELDS = [
  "id",
  "title",
  "description",
  "priority",
  "weight",
  "deadline",
  "urgency",
  "status",
  "decisionStatus",
  "sources",
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

const ARRAY_FIELDS = new Set(["sources", "aiEstimatedFields", "confirmedFields"]);
const BOOLEAN_FIELDS = new Set(["aiExtracted", "aiGenerated"]);

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
function buildColumnIndex(header, config = APP_CONFIG) {
  const normalized = header.map((h) => String(h || "").trim());
  const index = {};
  SHEET_FIELDS.forEach((field) => {
    const name = config.columns[field] || field;
    const at = normalized.indexOf(name);
    if (at >= 0) index[field] = at;
  });
  return index;
}

function rowToTask(row, columnIndex, config = APP_CONFIG) {
  const partial = {};
  SHEET_FIELDS.forEach((field) => {
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
  return makeTask(partial);
}

// 見出し行が欠けている・足りない場合に、どの列が無いのかを返す。
function missingColumns(header, config = APP_CONFIG) {
  const index = buildColumnIndex(header, config);
  return SHEET_FIELDS.filter((f) => index[f] == null).map((f) => config.columns[f] || f);
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
async function resolveTabName(config, listTabTitles) {
  const wanted = config.sheets.tabName;
  if (!config.sheets.fallbackToFirstTab) return { tabName: wanted, substituted: false };

  const titles = await listTabTitles();
  if (titles.includes(wanted)) return { tabName: wanted, substituted: false };
  if (titles.length === 0) throw new Error("スプレッドシートにタブが1つもありません");
  return { tabName: titles[0], substituted: true };
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
    const { tabName, substituted } = await this.resolveTab(config, token);

    const res = await fetch(valuesUrl(spreadsheetId, tabName), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`スプレッドシートを読めませんでした（${res.status}）`);
    const result = parseValues((await res.json()).values || [], config);
    if (substituted) {
      result.warnings.push(`「${config.sheets.tabName}」タブが無いため「${tabName}」を読みました`);
    }
    return result;
  },

  async save(tasks, config = APP_CONFIG) {
    const token = await this.getAccessToken();
    const { spreadsheetId } = config.sheets;
    // 保存前に現在の内容を読み、版番号で競合を確認する（要件4.9）。
    const current = await this.load(config);
    const conflicts = detectConflicts(tasks, current.tasks, config.behavior.conflictField);
    if (conflicts.length > 0) return { savedCount: 0, conflicts };

    const { tabName } = await this.resolveTab(config, token);
    const values = [headerRow(config), ...tasks.map((t) => taskToRow(t, config))];
    const res = await fetch(`${valuesUrl(spreadsheetId, tabName)}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) throw new Error(`保存に失敗しました（${res.status}）`);
    return { savedCount: tasks.length, conflicts: [] };
  },
};

function parseValues(values, config = APP_CONFIG) {
  const headerIndex = (config.sheets.headerRow || 1) - 1;
  const header = values[headerIndex] || [];
  const warnings = [];
  const missing = missingColumns(header, config);
  if (missing.length > 0) {
    warnings.push(`見出し行に見つからない列があります: ${missing.join(", ")}`);
  }
  const columnIndex = buildColumnIndex(header, config);
  const tasks = values
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
    .map((row) => rowToTask(row, columnIndex, config));
  return { tasks, warnings };
}

function selectProvider(config = APP_CONFIG) {
  if (config.sheets.authMode === "oauth") return GoogleSheetsProvider;
  if (config.sheets.authMode === "apiKey") return GoogleSheetsReadOnlyProvider;
  return LocalDraftProvider;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHEET_FIELDS,
    headerRow,
    taskToRow,
    rowToTask,
    buildColumnIndex,
    missingColumns,
    detectConflicts,
    parseValues,
    resolveTabName,
    tabTitlesFrom,
    selectProvider,
    LocalDraftProvider,
    GoogleSheetsProvider,
    GoogleSheetsReadOnlyProvider,
  };
}
