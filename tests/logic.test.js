// ロジックのテスト（依存なし）。
//   実行: node tests/logic.test.js
//
// js/*.js はブラウザ向けの素のスクリプトなので、vm で1つの共有コンテキストに
// 読み込んでからテストする。localStorage は最小限のスタブで代用する。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const sandbox = { localStorage: new MemoryStorage(), console, fetch: async () => { throw new Error("no network"); } };
vm.createContext(sandbox);
["js/config.js", "js/model.js", "js/auth.js", "js/sheets.js", "js/store.js"].forEach((file) => {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
});

// const 宣言は vm のグローバルに載らないため、コンテキスト内でまとめて取り出す。
const api = vm.runInContext(
  `({
    APP_CONFIG, SHEET_FIELDS,
    makeTask, validateTask, applyEdit, completeTask, reopenTask, archiveTask, mergeAiUpdate,
    sortTasks, filterTasks, groupByDeadline, hasUnconfirmedAi, isOverdue, daysUntilDeadline,
    headerRow, taskToRow, rowToTask, buildColumnIndex, missingColumns, detectConflicts,
    parseValues,
  mergeRow, resolveTabName, tabTitlesFrom, selectProvider, LocalDraftProvider, GoogleSheetsProvider,
    store, init, load, save, addTask, editTask, setStatus, confirmProposal, isDirty, getTask,
    GoogleAuth, isTokenValid, TOKEN_EXPIRY_MARGIN_MS,
  })`,
  sandbox
);

const {
  APP_CONFIG, makeTask, validateTask, applyEdit, completeTask, archiveTask, mergeAiUpdate,
  sortTasks, filterTasks, groupByDeadline, hasUnconfirmedAi, isOverdue,
  headerRow, taskToRow, rowToTask, buildColumnIndex, missingColumns, detectConflicts,
  parseValues, mergeRow, resolveTabName, tabTitlesFrom, selectProvider, LocalDraftProvider,
  store, init, load, save, addTask, editTask, setStatus, confirmProposal, isDirty, getTask,
  GoogleAuth, isTokenValid, TOKEN_EXPIRY_MARGIN_MS,
} = api;

const arr = (x) => Array.from(x);

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = new Date("2026-07-26T10:00:00+09:00");
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();

// ================= モデル =================

test("既定値: 未指定の項目が埋まる", () => {
  const t = makeTask({ title: "A" });
  assert.strictEqual(t.priority, "medium");
  assert.strictEqual(t.effort, "medium");
  assert.strictEqual(t.status, "未着手");
  assert.strictEqual(t.confirmation, "confirmed");
  assert.strictEqual(t.version, 1);
  assert.deepStrictEqual(arr(t.sources), []);
  assert.ok(t.id && t.createdAt && t.updatedAt);
});

test("検証: タスク名が必須（要件4.7）", () => {
  assert.deepStrictEqual(arr(validateTask(makeTask({ title: "" }))), ["タスク名を入力してください"]);
  assert.deepStrictEqual(arr(validateTask(makeTask({ title: "  " }))), ["タスク名を入力してください"]);
  assert.strictEqual(validateTask(makeTask({ title: "A" })).length, 0);
});

test("検証: 壊れた期限を弾く", () => {
  const errors = arr(validateTask(makeTask({ title: "A", deadline: "いつか" })));
  assert.ok(errors.some((e) => e.includes("期限")));
});

test("編集: 触った項目が confirmedFields に積まれる（要件6.3）", () => {
  const base = makeTask({ title: "A", priority: "low" });
  const next = applyEdit(base, { priority: "high", title: "A" });
  assert.strictEqual(next.priority, "high");
  assert.deepStrictEqual(arr(next.confirmedFields), ["priority"]);
});

test("AI更新: 本人が確定した項目を上書きしない（受け入れ条件11）", () => {
  const base = applyEdit(makeTask({ title: "A", priority: "low" }), { priority: "high" });
  const merged = mergeAiUpdate(base, { priority: "low", effort: "heavy", title: "AIが直した名前" });
  assert.strictEqual(merged.priority, "high", "確定済みの優先順位は守られる");
  assert.strictEqual(merged.effort, "heavy", "未確定の項目は反映される");
  assert.strictEqual(merged.title, "AIが直した名前");
  assert.strictEqual(JSON.stringify(merged.pendingProposal), '{"priority":"low"}', "弾いた提案は別に残す");
});

test("AI更新: 完了・アーカイブ状態を壊さない（受け入れ条件11）", () => {
  const done = completeTask(makeTask({ title: "A" }));
  const merged = mergeAiUpdate(done, { status: "未着手", title: "A" });
  assert.strictEqual(merged.status, "完了");
  assert.ok(merged.completedAt);

  const archived = archiveTask(makeTask({ title: "B" }));
  assert.strictEqual(mergeAiUpdate(archived, { status: "未着手" }).status, "キャンセル");
});

test("アーカイブ: 物理削除せず記録を残す（要件4.8）", () => {
  const t = archiveTask(makeTask({ title: "A" }));
  assert.strictEqual(t.status, "キャンセル");
  assert.ok(t.archivedAt);
});

// ================= 並び替え・絞り込み =================

test("並び順: 既定は期限の近い順（要件4.5）", () => {
  const list = [
    makeTask({ title: "あさって", deadline: hoursFromNow(48) }),
    makeTask({ title: "きょう", deadline: hoursFromNow(2) }),
    makeTask({ title: "あした", deadline: hoursFromNow(24) }),
  ];
  assert.deepStrictEqual(arr(sortTasks(list)).map((t) => t.title), ["きょう", "あした", "あさって"]);
});

test("並び順: 同じ期限なら優先順位の高い順", () => {
  const list = [
    makeTask({ title: "低", deadline: hoursFromNow(5), priority: "low" }),
    makeTask({ title: "高", deadline: hoursFromNow(5), priority: "high" }),
    makeTask({ title: "中", deadline: hoursFromNow(5), priority: "medium" }),
  ];
  assert.deepStrictEqual(arr(sortTasks(list)).map((t) => t.title), ["高", "中", "低"]);
});

test("並び順: 期限なしの位置を設定で変えられる（要決定事項）", () => {
  const list = [makeTask({ title: "期限なし" }), makeTask({ title: "期限あり", deadline: hoursFromNow(3) })];
  assert.strictEqual(arr(sortTasks(list, { noDeadlinePosition: "last" }))[0].title, "期限あり");
  assert.strictEqual(arr(sortTasks(list, { noDeadlinePosition: "first" }))[0].title, "期限なし");
});

test("絞り込み: 優先順位・重さで絞れる（要件4.5）", () => {
  const list = [
    makeTask({ title: "A", priority: "high", effort: "light" }),
    makeTask({ title: "B", priority: "low", effort: "heavy" }),
  ];
  assert.deepStrictEqual(arr(filterTasks(list, { priority: "high" })).map((t) => t.title), ["A"]);
  assert.deepStrictEqual(arr(filterTasks(list, { effort: "heavy" })).map((t) => t.title), ["B"]);
});

test("絞り込み: 期限あり・緊急・AI未確認で絞れる（要件4.5）", () => {
  const list = [
    makeTask({ title: "期限あり", deadline: hoursFromNow(5) }),
    makeTask({ title: "緊急", urgency: "high" }),
    makeTask({ title: "AI未確認", aiEstimatedFields: ["deadline"] }),
    makeTask({ title: "ふつう" }),
  ];
  assert.deepStrictEqual(arr(filterTasks(list, { hasDeadline: true }, NOW)).map((t) => t.title), ["期限あり"]);
  assert.deepStrictEqual(arr(filterTasks(list, { urgentOnly: true }, NOW)).map((t) => t.title), ["緊急"]);
  assert.deepStrictEqual(arr(filterTasks(list, { aiUnconfirmedOnly: true }, NOW)).map((t) => t.title), ["AI未確認"]);
});

test("絞り込み: 期限切れも緊急に含める", () => {
  const overdue = makeTask({ title: "過ぎている", deadline: hoursFromNow(-5) });
  assert.strictEqual(isOverdue(overdue, NOW), true);
  assert.strictEqual(arr(filterTasks([overdue], { urgentOnly: true }, NOW)).length, 1);
});

test("AI未確認: 本人が確認した項目は未確認に数えない（要件4.4）", () => {
  const t = makeTask({ title: "A", aiEstimatedFields: ["deadline"], confirmedFields: ["deadline"] });
  assert.strictEqual(hasUnconfirmedAi(t), false);
  assert.strictEqual(hasUnconfirmedAi(makeTask({ title: "B", aiEstimatedFields: ["effort"] })), true);
});

test("AI未確認: 未採用のAI生成タスクは未確認扱い", () => {
  const t = makeTask({ title: "A", aiGenerated: true, confirmation: "proposed" });
  assert.strictEqual(hasUnconfirmedAi(t), true);
});

test("日付の見出し: 期限切れ／今日／明日／期限なしに分かれる（要件4.4）", () => {
  const list = sortTasks([
    makeTask({ title: "過ぎた", deadline: hoursFromNow(-30) }),
    makeTask({ title: "今日", deadline: hoursFromNow(4) }),
    makeTask({ title: "明日", deadline: hoursFromNow(26) }),
    makeTask({ title: "なし" }),
  ]);
  const labels = arr(groupByDeadline(list, NOW)).map((g) => g.label);
  assert.deepStrictEqual(labels, ["期限切れ", "今日", "明日", "期限なし"]);
});

// ================= スプレッドシート入出力 =================

test("見出し行: 論理名から列名へ変換される（要件6.1）", () => {
  const header = arr(headerRow(APP_CONFIG));
  assert.strictEqual(header.length, 27);
  assert.strictEqual(header[0], "task_id");
  assert.ok(header.includes("confirmedFields"));
});

test("行変換: 書き出して読み戻すと同じ値になる", () => {
  const original = makeTask({
    title: "面談ログを整理する",
    description: "7/25の分",
    priority: "high",
    effort: "heavy",
    deadline: hoursFromNow(20),
    urgency: "high",
    sources: ["50_活動/学習.md", "80_受信箱/メモ.md"],
    aiExtracted: true,
    aiEstimatedFields: ["deadline", "effort"],
    confirmedFields: ["priority"],
    version: 3,
  });
  const row = taskToRow(original, APP_CONFIG);
  const index = buildColumnIndex(arr(headerRow(APP_CONFIG)), APP_CONFIG);
  const back = rowToTask(row, index, APP_CONFIG);

  ["title", "description", "priority", "effort", "deadline", "urgency", "status", "confirmation", "version"]
    .forEach((f) => assert.strictEqual(back[f], original[f], `${f} が一致しない`));
  assert.strictEqual(back.aiExtracted, true);
  assert.strictEqual(back.aiGenerated, false);
  assert.deepStrictEqual(arr(back.sources), ["50_活動/学習.md", "80_受信箱/メモ.md"]);
  assert.deepStrictEqual(arr(back.aiEstimatedFields), ["deadline", "effort"]);
});

test("行変換: 列の順番が入れ替わっても見出しで対応づける", () => {
  const values = [
    ["title", "task_id", "priority", "status"],
    ["並び替えテスト", "t1", "high", "未着手"],
  ];
  const { tasks } = parseValues(values, APP_CONFIG);
  assert.strictEqual(tasks[0].id, "t1");
  assert.strictEqual(tasks[0].title, "並び替えテスト");
  assert.strictEqual(tasks[0].priority, "high");
});

test("行変換: 足りない列を警告する", () => {
  const header = ["task_id", "title", "status"];
  const { warnings } = parseValues([header, ["t1", "A", "未着手"]], APP_CONFIG);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes("priority"));
  assert.ok(arr(missingColumns(header, APP_CONFIG)).includes("deadline"));
});

test("行更新: アプリが知らない列を消さない", () => {
  // 全面PUTをやめて行単位の更新にした理由そのもの。
  // シート側にアプリが扱わない列があっても、書き戻しで空にしてはいけない。
  const header = arr(headerRow(APP_CONFIG)).concat(["社内メモ"]);
  const index = buildColumnIndex(header, APP_CONFIG);
  const raw = new Array(header.length).fill("");
  raw[index.id] = "t1";
  raw[index.title] = "元のタイトル";
  raw[index.status] = "未着手";
  raw[header.length - 1] = "消えたら困る値";

  const task = rowToTask(raw, index, APP_CONFIG);
  task.title = "直したタイトル";
  const merged = arr(mergeRow(task, index, APP_CONFIG));

  assert.strictEqual(merged[index.title], "直したタイトル");
  assert.strictEqual(merged[index.id], "t1", "IDを勝手に振り直さない");
  assert.strictEqual(merged[header.length - 1], "消えたら困る値", "知らない列は温存する");
});

test("行更新: createdAt は書き換えない", () => {
  const header = arr(headerRow(APP_CONFIG));
  const index = buildColumnIndex(header, APP_CONFIG);
  const raw = new Array(header.length).fill("");
  raw[index.id] = "t1";
  raw[index.title] = "A";
  raw[index.status] = "未着手";
  raw[index.createdAt] = "2026-01-01T00:00:00+09:00";

  const task = rowToTask(raw, index, APP_CONFIG);
  task.createdAt = "2099-01-01T00:00:00+09:00";
  const merged = arr(mergeRow(task, index, APP_CONFIG));
  assert.strictEqual(merged[index.createdAt], "2026-01-01T00:00:00+09:00");
});

test("安全弁: 必須列が無いシートは読み込まない", () => {
  assert.throws(
    () => parseValues([["id", "title", "weight"], ["t1", "旧スキーマ", "light"]], APP_CONFIG),
    /見出し行が想定と違います/
  );
});

test("安全弁: まっさらなシートは通す（新規作成できるように）", () => {
  const r = parseValues([], APP_CONFIG);
  assert.strictEqual(r.isEmpty, true);
  assert.strictEqual(arr(r.tasks).length, 0);
});

test("行変換: 空行を読み飛ばす", () => {
  const values = [arr(headerRow(APP_CONFIG)), [], ["", "", ""], ["t1", "A"]];
  assert.strictEqual(parseValues(values, APP_CONFIG).tasks.length, 1);
});

test("行変換: 配列列が壊れていても落ちない", () => {
  const index = buildColumnIndex(arr(headerRow(APP_CONFIG)), APP_CONFIG);
  const row = [];
  row[index.id] = "t1";
  row[index.title] = "A";
  row[index.sources] = "これはJSONではない";
  const task = rowToTask(row, index, APP_CONFIG);
  assert.deepStrictEqual(arr(task.sources), ["これはJSONではない"]);
});

test("競合検出: 版番号が進んでいたら衝突として返す（要件4.9）", () => {
  const local = [{ id: "t1", title: "A", baseVersion: 2, version: 3 }];
  assert.strictEqual(arr(detectConflicts(local, [{ id: "t1", version: 2 }])).length, 0);
  const conflicts = arr(detectConflicts(local, [{ id: "t1", version: 5 }]));
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].id, "t1");
});

test("接続方式: 設定に応じてアダプタが選ばれる", () => {
  assert.strictEqual(selectProvider({ ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, authMode: "none" } }).key, "local");
  assert.strictEqual(selectProvider({ ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, authMode: "apiKey" } }).key, "apiKey");
  assert.strictEqual(selectProvider({ ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, authMode: "oauth" } }).key, "oauth");
});

test("タブ解決: 設定した名前のタブがあればそれを使う", async () => {
  const r = await resolveTabName(APP_CONFIG, async () => ["メモ", "Tasks", "その他"]);
  assert.strictEqual(r.tabName, "Tasks");
  assert.strictEqual(r.substituted, false);
});

test("タブ解決: 見つからなければ中止する（既定）", async () => {
  // [変更 2026-07-28] 以前は先頭のタブで代用していた。tasks -> Tasks の移行時に
  // 別スキーマのシートを掴んで全面上書きしかけたため、既定で止めるようにした。
  await assert.rejects(
    () => resolveTabName(APP_CONFIG, async () => ["AI Todo タスク正本", "メモ"]),
    /タブが見つかりません/
  );
});

test("タブ解決: 明示的に許可したときだけ先頭のタブで代用する", async () => {
  const cfg = { ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, fallbackToFirstTab: true } };
  const r = await resolveTabName(cfg, async () => ["AI Todo タスク正本", "メモ"]);
  assert.strictEqual(r.tabName, "AI Todo タスク正本");
  assert.strictEqual(r.substituted, true);
});

test("タブ解決: タブが1つも無ければエラーにする", async () => {
  const cfg = { ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, fallbackToFirstTab: true } };
  await assert.rejects(() => resolveTabName(cfg, async () => []), /タブが1つもありません/);
});

test("タブ一覧: APIの応答からタブ名を取り出す", () => {
  const titles = arr(tabTitlesFrom({ sheets: [{ properties: { title: "tasks" } }, { properties: {} }] }));
  assert.deepStrictEqual(titles, ["tasks"]);
  assert.deepStrictEqual(arr(tabTitlesFrom({})), []);
});

test("接続方式: 読み取り専用アダプタは書き込みを拒否する", () => {
  const p = selectProvider({ ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, authMode: "apiKey" } });
  assert.strictEqual(p.isWritable(), false);
});

// ================= 認証 =================

test("トークン: 期限内なら有効、切れていれば無効", () => {
  const now = Date.now();
  assert.strictEqual(isTokenValid({ value: "t", expiresAt: now + 1000 }, now), true);
  assert.strictEqual(isTokenValid({ value: "t", expiresAt: now - 1 }, now), false);
  assert.strictEqual(isTokenValid({ value: "", expiresAt: now + 1000 }, now), false);
  assert.strictEqual(isTokenValid(null, now), false);
});

test("トークン: 失効の手前で切れた扱いにする余裕がある", () => {
  assert.ok(TOKEN_EXPIRY_MARGIN_MS > 0, "通信中の失効を避けるための余裕");
});

test("認証: クライアントID未設定を判定できる", () => {
  const withId = { ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, oauth: { clientId: "x", scope: "s" } } };
  const without = { ...APP_CONFIG, sheets: { ...APP_CONFIG.sheets, oauth: { clientId: "", scope: "s" } } };
  assert.strictEqual(GoogleAuth.isConfigured(withId), true);
  assert.strictEqual(GoogleAuth.isConfigured(without), false);
});

test("認証: トークンが無い状態では、勝手にポップアップを開かず案内を返す", async () => {
  GoogleAuth.token = null;
  await assert.rejects(() => GoogleAuth.getToken(), /Googleに接続してください/);
});

test("認証: 期限切れのトークンは捨てて、接続をやり直させる", async () => {
  GoogleAuth.token = { value: "old", expiresAt: Date.now() - 1000 };
  await assert.rejects(() => GoogleAuth.getToken(), /Googleに接続してください/);
  assert.strictEqual(GoogleAuth.token, null, "古いトークンを持ち続けない");
});

test("認証: 有効なトークンがあればそれを返す", async () => {
  GoogleAuth.token = { value: "live-token", expiresAt: Date.now() + 600000 };
  assert.strictEqual(await GoogleAuth.getToken(), "live-token");
  GoogleAuth.token = null;
});

// ---- 同意画面を毎回出さない（2026-07-27） ----
// 以前は「メモリにトークンがあるか」で初回判定していたため、リロードするたび
// 初回扱いになり、開くたびにフル同意画面が出ていた。

// prompt に何が渡ったかを記録する、偽のトークンクライアント。
function fakeTokenClient(outcome = "ok") {
  const client = {
    prompts: [],
    requestAccessToken(options) {
      client.prompts.push(options.prompt);
      setTimeout(() => {
        if (outcome === "ok") client.callback({ access_token: "ya29-secret-token", expires_in: 3600 });
        else client.callback({ error: outcome });
      }, 0);
    },
  };
  return client;
}

function withAuth(outcome, fn) {
  const client = fakeTokenClient(outcome);
  GoogleAuth.token = null;
  GoogleAuth.tokenClient = client;
  sandbox.localStorage.clear();
  return fn(client).finally(() => {
    GoogleAuth.token = null;
    GoogleAuth.tokenClient = null;
    sandbox.localStorage.clear();
  });
}

test("認証: 初回は同意画面を出す", async () => {
  await withAuth("ok", async (client) => {
    await GoogleAuth.connect(APP_CONFIG);
    assert.deepStrictEqual(client.prompts, ["consent"]);
  });
});

test("認証: 一度同意すれば、リロード後も同意画面を出さない", async () => {
  await withAuth("ok", async (client) => {
    await GoogleAuth.connect(APP_CONFIG);
    // リロードを模す。メモリ上のトークンは消えるが、覚えは端末に残る。
    GoogleAuth.token = null;
    await GoogleAuth.connect(APP_CONFIG);
    assert.deepStrictEqual(client.prompts, ["consent", ""], "2回目は確認画面を飛ばす");
  });
});

test("認証: 同意済みでも許可が切れていたら、覚えを捨てて押し直させる", async () => {
  const config = APP_CONFIG;
  await withAuth("interaction_required", async (client) => {
    GoogleAuth.rememberConsent(config, true);
    await assert.rejects(() => GoogleAuth.connect(config), /もう一度/);
    assert.deepStrictEqual(client.prompts, [""], "失敗のあと自動でやり直さない（ポップアップが塞がれる）");
    assert.strictEqual(GoogleAuth.hasConsented(config), false, "覚えを捨てて次回は同意画面から");
  });
});

test("認証: 接続を切ると覚えも消える", async () => {
  await withAuth("ok", async () => {
    await GoogleAuth.connect(APP_CONFIG);
    assert.strictEqual(GoogleAuth.hasConsented(APP_CONFIG), true);
    GoogleAuth.disconnect(APP_CONFIG);
    assert.strictEqual(GoogleAuth.hasConsented(APP_CONFIG), false);
  });
});

test("認証: rememberConsent を false にすると毎回同意画面に戻る", async () => {
  const config = {
    ...APP_CONFIG,
    sheets: { ...APP_CONFIG.sheets, oauth: { ...APP_CONFIG.sheets.oauth, rememberConsent: false } },
  };
  await withAuth("ok", async (client) => {
    await GoogleAuth.connect(config);
    GoogleAuth.token = null;
    await GoogleAuth.connect(config);
    assert.deepStrictEqual(client.prompts, ["consent", "consent"]);
  });
});

test("認証: アカウントを覚えていなければ hint を渡さない", () => {
  sandbox.localStorage.clear();
  assert.ok(!("hint" in GoogleAuth.tokenClientOptions(APP_CONFIG)), "空なら渡さない（選択画面が出る）");
});

test("認証: 端末に覚えたアカウントを hint として渡す", () => {
  sandbox.localStorage.clear();
  GoogleAuth.setAccountHint(APP_CONFIG, "  me@example.com  ");
  assert.strictEqual(GoogleAuth.getAccountHint(APP_CONFIG), "me@example.com", "前後の空白は落とす");
  assert.strictEqual(GoogleAuth.tokenClientOptions(APP_CONFIG).hint, "me@example.com");
  sandbox.localStorage.clear();
});

test("認証: アカウントは公開する設定ファイルではなく端末側に置く", () => {
  assert.strictEqual(APP_CONFIG.sheets.oauth.accountHint, "",
    "config.js は公開されるのでアドレスを書かない");
});

test("認証: アカウントを変えたら、作り置きのクライアントと同意の覚えを捨てる", () => {
  sandbox.localStorage.clear();
  GoogleAuth.setAccountHint(APP_CONFIG, "first@example.com");
  GoogleAuth.rememberConsent(APP_CONFIG, true);
  GoogleAuth.tokenClient = { dummy: true };

  GoogleAuth.setAccountHint(APP_CONFIG, "second@example.com");
  assert.strictEqual(GoogleAuth.tokenClient, null, "古い hint を握ったクライアントを使い回さない");
  assert.strictEqual(GoogleAuth.hasConsented(APP_CONFIG), false, "別アカウントの同意は取れていない");
  sandbox.localStorage.clear();
});

test("認証: 同じアカウントを入れ直しても、同意の覚えは消さない", () => {
  sandbox.localStorage.clear();
  GoogleAuth.setAccountHint(APP_CONFIG, "same@example.com");
  GoogleAuth.rememberConsent(APP_CONFIG, true);
  GoogleAuth.setAccountHint(APP_CONFIG, "same@example.com");
  assert.strictEqual(GoogleAuth.hasConsented(APP_CONFIG), true);
  sandbox.localStorage.clear();
});

test("認証: アクセストークンは端末に保存しない", async () => {
  await withAuth("ok", async () => {
    await GoogleAuth.connect(APP_CONFIG);
    const saved = [...sandbox.localStorage.map.values()].join(" ");
    assert.ok(!saved.includes("ya29-secret-token"), "覚えるのは真偽値だけ。トークンは残さない");
  });
});

// ================= 状態管理 =================

async function runStoreTests() {
  const asyncTests = [];
  const atest = (name, fn) => asyncTests.push({ name, fn });

  atest("追加すると未保存になる（要件4.9）", async () => {
    init(LocalDraftProvider);
    await load();
    assert.strictEqual(isDirty(), false);
    const r = addTask({ title: "新しいタスク" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(isDirty(), true, "自動保存せず未保存のまま溜まる");
  });

  atest("追加したタスクは直接入力として記録される（要件6.2）", async () => {
    init(LocalDraftProvider);
    await load();
    const r = addTask({ title: "手で足したタスク", priority: "high" });
    assert.deepStrictEqual(arr(r.task.sources), ["本人による直接入力"]);
    assert.strictEqual(r.task.confirmation, "confirmed");
  });

  atest("追加: 既定値のままの項目は確定扱いにしない（AI同期が推定できる余地を残す）", async () => {
    init(LocalDraftProvider);
    await load();
    const r = addTask({
      title: "既定値のまま追加したタスク",
      description: "",
      priority: "medium",
      weight: "medium",
      deadline: null,
      urgency: null,
    });
    assert.deepStrictEqual(arr(r.task.confirmedFields), ["title"], "タスク名だけが確定");
    // AI更新で期限や重さを埋められること
    const merged = mergeAiUpdate(r.task, { deadline: hoursFromNow(24), weight: "heavy" });
    assert.strictEqual(merged.deadline, hoursFromNow(24));
    assert.strictEqual(merged.weight, "heavy");
  });

  atest("追加: 既定値から変えた項目は確定扱いにする", async () => {
    init(LocalDraftProvider);
    await load();
    const r = addTask({
      title: "手で決めたタスク",
      description: "",
      priority: "high",
      weight: "medium",
      deadline: hoursFromNow(48),
      urgency: null,
    });
    assert.deepStrictEqual(arr(r.task.confirmedFields).sort(), ["deadline", "priority", "title"]);

    // 確定した項目はAI更新で書き換わらない
    const merged = mergeAiUpdate(r.task, { priority: "low", weight: "light" });
    assert.strictEqual(merged.priority, "high", "本人が決めた優先順位は守られる");
    assert.strictEqual(merged.weight, "light", "既定値のままだった重さは更新される");
  });

  atest("タスク名が空なら追加できない", async () => {
    init(LocalDraftProvider);
    await load();
    const before = store.tasks.length;
    const r = addTask({ title: "   " });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(store.tasks.length, before);
  });

  atest("更新すると保存され、版番号が上がる（要件4.9）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    addTask({ title: "保存されるタスク" });
    const result = await save();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(store.syncState, "saved");
    assert.strictEqual(store.tasks[0].version, 2);
    assert.strictEqual(isDirty(), false);
  });

  atest("保存した内容を読み直せる（受け入れ条件4・7）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    addTask({ title: "残るタスク" });
    await save();

    store.tasks = [];
    await load();
    assert.strictEqual(store.tasks.length, 1);
    assert.strictEqual(store.tasks[0].title, "残るタスク");
  });

  atest("保存に失敗しても変更を失わない（要件7.2・受け入れ条件8）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    addTask({ title: "消えてはいけないタスク" });

    const broken = {
      key: "broken",
      isWritable: () => true,
      describe: () => "失敗するアダプタ",
      load: async () => ({ tasks: [], warnings: [] }),
      save: async () => { throw new Error("通信に失敗しました"); },
    };
    init(broken);
    const result = await save();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(store.syncState, "error");
    assert.strictEqual(store.message, "通信に失敗しました");
    assert.strictEqual(store.tasks.length, 1, "未保存の変更は残る");
    assert.strictEqual(store.tasks[0].title, "消えてはいけないタスク");
  });

  atest("競合が返ったら保存せずに知らせる（要件4.9）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    addTask({ title: "衝突するタスク" });

    const conflicting = {
      key: "conflict",
      isWritable: () => true,
      describe: () => "競合するアダプタ",
      load: async () => ({ tasks: [], warnings: [] }),
      save: async (tasks) => ({ savedCount: 0, conflicts: [{ id: tasks[0].id, title: tasks[0].title }] }),
    };
    init(conflicting);
    const result = await save();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(store.conflicts.length, 1);
    assert.ok(store.message.includes("更新された"));
  });

  atest("読み取り専用の接続では保存しない", async () => {
    init({ key: "ro", isWritable: () => false, describe: () => "読み取り専用", load: async () => ({ tasks: [], warnings: [] }) });
    const result = await save();
    assert.strictEqual(result.ok, false);
    assert.ok(store.message.includes("書き込みできません"));
  });

  atest("完了・アーカイブ・戻すが動く（要件4.8）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    const { task } = addTask({ title: "状態を変えるタスク" });

    setStatus(task.id, "done");
    assert.strictEqual(getTask(task.id).status, "完了");
    assert.ok(getTask(task.id).completedAt);

    setStatus(task.id, "archived");
    assert.strictEqual(getTask(task.id).status, "キャンセル");

    setStatus(task.id, "todo");
    assert.strictEqual(getTask(task.id).status, "未着手");
    assert.strictEqual(getTask(task.id).completedAt, null);
  });

  atest("AI提案を採用すると確定タスクになる（要件4.3）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    store.tasks.push(makeTask({
      title: "AIが提案したタスク",
      confirmation: "proposed",
      aiGenerated: true,
      aiEstimatedFields: ["deadline"],
    }));
    const id = store.tasks[0].id;
    confirmProposal(id);
    assert.strictEqual(getTask(id).confirmation, "confirmed");
    assert.ok(arr(getTask(id).confirmedFields).includes("deadline"));
    assert.strictEqual(hasUnconfirmedAi(getTask(id)), false);
  });

  atest("編集した項目は確定扱いになる（要件6.3）", async () => {
    sandbox.localStorage.clear();
    init(LocalDraftProvider);
    await load();
    const { task } = addTask({ title: "編集されるタスク" });
    editTask(task.id, { priority: "high" });
    assert.strictEqual(getTask(task.id).priority, "high");
    assert.ok(arr(getTask(task.id).confirmedFields).includes("priority"));
  });

  for (const t of asyncTests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      failures.push({ name: t.name, err });
    }
  }
}

// ================= 実行 =================

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, err });
    }
  }
  await runStoreTests();

  console.log(`\n通過: ${passed} / ${passed + failures.length}`);
  if (failures.length > 0) {
    console.log(`\n失敗: ${failures.length}件`);
    failures.forEach((f) => {
      console.log(`\n  ✗ ${f.name}`);
      console.log(`    ${String(f.err.message).split("\n").slice(0, 3).join("\n    ")}`);
    });
    process.exit(1);
  }
  console.log("すべて通過しました。\n");
})();
