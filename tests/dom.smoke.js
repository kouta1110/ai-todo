// 画面の通しテスト。
//   準備: npm install jsdom
//   実行: node tests/dom.smoke.js
//
// 要件定義書9章「受け入れ条件」のうち、Googleスプレッドシート実接続を伴わずに
// 確認できる項目（4,7,9,10,11,12,13,14,15）を画面操作で検証する。

const fs = require("fs");
const path = require("path");
const assert = require("assert");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("jsdom が見つかりません。`npm install jsdom` を実行してください。");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const CONFIG_SCRIPT = "js/config.js";
const SCRIPTS = ["js/model.js", "js/auth.js", "js/sheets.js", "js/store.js", "js/app.js"];

const bootedWindows = [];

// authMode は実運用の設定に左右されないよう、テスト側で明示する。
// 全スクリプトを1つのスコープで評価するので、config.js の直後に上書きを差し込める。
function boot(store = new Map(), options = {}) {
  const dom = new JSDOM(html, { url: "https://example.com/", runScripts: "dangerously" });
  const { window } = dom;
  bootedWindows.push(window);

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
  });

  // jsdom は動画を再生できず、play() を呼ぶだけで警告を吐く。
  // 再生の可否そのものは実機でしか確かめられないので、ここでは差し替えておく。
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

  if (options.beforeScripts) options.beforeScripts(window);

  const override = `
    ;APP_CONFIG.sheets.authMode = ${JSON.stringify(options.authMode || "none")};
    APP_CONFIG.sheets.oauth.clientId = ${JSON.stringify(options.clientId || "")};
    APP_CONFIG.display.splash = Object.assign(
      {}, APP_CONFIG.display.splash, { minMs: 0, fadeMs: 0 }, ${JSON.stringify(options.splash || {})});`;

  const source =
    fs.readFileSync(path.join(root, CONFIG_SCRIPT), "utf8") +
    override +
    "\n;\n" +
    SCRIPTS.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n;\n") +
    `
    ;window.__app = {
      get APP_CONFIG() { return APP_CONFIG; },
      get state() { return store; },
      get filters() { return filters; },
      get auth() { return GoogleAuth; },
      showView, openDetail, render, makeTask, makeProject, isDirty, save, load, getTask,
    };`;
  window.eval(source);
  return { window, doc: window.document, store, app: window.__app };
}

// 起動直後の非同期な読み込みが終わるのを待つ。
const settle = () => new Promise((r) => setImmediate(r));

const $ = (doc, sel) => doc.querySelector(sel);
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];
const text = (doc, sel) => ($(doc, sel) ? $(doc, sel).textContent.trim() : null);
const activeView = (doc) => $(doc, ".screen.active").id;
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function addTaskViaUi(ctx, { title, priority = "medium", weight = "medium", deadline = "", urgency = "" }) {
  const { doc, window } = ctx;
  click($(doc, "#btn-add"));
  assert.strictEqual(activeView(doc), "view-detail");
  $(doc, "#f-title").value = title;
  $(doc, "#f-priority").value = priority;
  $(doc, "#f-weight").value = weight;
  $(doc, "#f-deadline").value = deadline;
  $(doc, "#f-urgency").value = urgency;
  $(doc, "#task-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

function localInput(offsetHours) {
  const d = new Date(Date.now() + offsetHours * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 起動 ----

test("起動: メイン画面が開き、タスクが無い旨を出す", async () => {
  const { doc } = boot();
  await settle();
  assert.strictEqual(activeView(doc), "view-list");
  assert.strictEqual(text(doc, "#page-title"), "今やること");
  assert.match(text(doc, "#task-list"), /タスクがありません/);
});

test("起動: 未接続であることを画面に出す（要件2.1・ダミー運用を完成としない）", async () => {
  const { doc } = boot();
  await settle();
  assert.ok(!$(doc, "#notice").classList.contains("hidden"));
  assert.match(text(doc, "#notice"), /スプレッドシート未接続/);
});

test("起動: メイン画面にタイマー・空き時間・実績を置かない（要件5.1）", async () => {
  const { doc } = boot();
  await settle();
  const body = $(doc, "#view-list").textContent;
  ["空いています", "タイマー", "集中時間", "達成率", "カレンダー"].forEach((word) => {
    assert.ok(!body.includes(word), `メイン画面に「${word}」が出ている`);
  });
});

// ---- 一覧表示 ----

test("一覧: 期限の近い順に並ぶ（受け入れ条件9）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "あさって", deadline: localInput(48) });
  await addTaskViaUi(ctx, { title: "きょう", deadline: localInput(3) });
  await addTaskViaUi(ctx, { title: "あした", deadline: localInput(26) });

  const titles = $$(ctx.doc, "#task-list .task-title").map((n) => n.textContent);
  assert.deepStrictEqual(titles, ["きょう", "あした", "あさって"]);
});

test("一覧: 日付の見出しでまとまる", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "きょう", deadline: localInput(3) });
  await addTaskViaUi(ctx, { title: "あした", deadline: localInput(26) });
  const labels = $$(ctx.doc, "#task-list .date-head h2").map((n) => n.textContent);
  assert.deepStrictEqual(labels, ["今日", "明日"]);
});

test("一覧: 優先順位が文字サイズと太さで表される（受け入れ条件10）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "高", priority: "high", deadline: localInput(2) });
  await addTaskViaUi(ctx, { title: "低", priority: "low", deadline: localInput(3) });

  const nodes = $$(ctx.doc, "#task-list .task-title");
  const high = nodes.find((n) => n.textContent === "高");
  const low = nodes.find((n) => n.textContent === "低");
  const sizes = ctx.app.APP_CONFIG.display.prioritySizeRem;
  assert.strictEqual(high.style.getPropertyValue("--title-size"), `${sizes.high}rem`);
  assert.strictEqual(low.style.getPropertyValue("--title-size"), `${sizes.low}rem`);
  assert.ok(
    parseFloat(high.style.getPropertyValue("--title-size")) > parseFloat(low.style.getPropertyValue("--title-size"))
  );
  assert.notStrictEqual(
    high.style.getPropertyValue("--title-weight"),
    low.style.getPropertyValue("--title-weight")
  );
});

test("一覧: 優先順位を色以外でも区別できる（要件7.1）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "高", priority: "high", deadline: localInput(2) });
  await addTaskViaUi(ctx, { title: "低", priority: "low", deadline: localInput(3) });
  const marks = $$(ctx.doc, "#task-list .task-mark").map((n) => n.textContent);
  assert.strictEqual(new Set(marks).size, 2, "行頭の印が優先順位ごとに違う");
});

test("一覧: 重さ・期限・緊急度が判断材料として出る（受け入れ条件10）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "重いタスク", weight: "heavy", urgency: "high", deadline: localInput(5) });
  const meta = text(ctx.doc, "#task-list .task-meta");
  assert.match(meta, /重さ 重い/);
  assert.match(meta, /優先/);
  assert.match(meta, /すぐ/);
});

test("一覧: 期限切れが区別して表示される", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "過ぎている", deadline: localInput(-30) });
  assert.match(text(ctx.doc, "#task-list .date-head h2"), /期限切れ/);
  assert.match(text(ctx.doc, "#task-list .tag.urgent"), /期限切れ/);
});

test("一覧: 完了・アーカイブは初期表示から外れる（要件4.4）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "消えるタスク", deadline: localInput(3) });
  click($(ctx.doc, "#task-list .task-check"));
  await settle();
  assert.ok(!text(ctx.doc, "#task-list").includes("消えるタスク"));
});

// ---- AI提案 ----

test("AI提案: 確定タスクと別枠に出る（受け入れ条件15）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "確定タスク", deadline: localInput(3) });

  ctx.app.state.tasks.push(
    ctx.app.makeTask({ title: "AIの提案", confirmation: "proposed", aiGenerated: true })
  );
  ctx.app.render();

  assert.ok(!$(ctx.doc, "#proposals").classList.contains("hidden"));
  assert.match(text(ctx.doc, "#proposal-list"), /AIの提案/);
  assert.ok(!text(ctx.doc, "#task-list").includes("AIの提案"), "確定タスクの一覧には混ざらない");
});

test("AI提案: 採用すると確定タスクへ移る（受け入れ条件12・15）", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.tasks.push(
    ctx.app.makeTask({ title: "採用する提案", confirmation: "proposed", aiGenerated: true, deadline: new Date(Date.now() + 7200000).toISOString() })
  );
  ctx.app.render();
  click($(ctx.doc, "#proposal-list .task-check"));
  await settle();

  assert.ok($(ctx.doc, "#proposals").classList.contains("hidden"));
  assert.match(text(ctx.doc, "#task-list"), /採用する提案/);
});

test("AI未確認: 一覧に印が出る（受け入れ条件12）", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.tasks.push(
    ctx.app.makeTask({ title: "推定つき", aiExtracted: true, aiEstimatedFields: ["deadline"] })
  );
  ctx.app.render();
  assert.match(text(ctx.doc, "#task-list .tag.ai"), /AI未確認/);
});

test("詳細: AIの関与と出典を確認できる（要件5.2・受け入れ条件2）", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.tasks.push(
    ctx.app.makeTask({
      title: "抽出タスク",
      aiExtracted: true,
      aiEstimatedFields: ["deadline"],
      sources: ["50_活動/学習.md"],
    })
  );
  ctx.app.render();
  click($(ctx.doc, "#task-list .task"));
  await settle();

  assert.strictEqual(activeView(ctx.doc), "view-detail");
  assert.match(text(ctx.doc, "#ai-info"), /Obsidianから抽出/);
  assert.match(text(ctx.doc, "#ai-info"), /未確認: deadline/);
  assert.match(text(ctx.doc, "#source-info"), /50_活動\/学習\.md/);
});

// ---- 絞り込み ----

test("絞り込み: 優先順位で絞れる（要件4.5）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "高いタスク", priority: "high", deadline: localInput(2) });
  await addTaskViaUi(ctx, { title: "低いタスク", priority: "low", deadline: localInput(3) });

  const highBtn = $$(ctx.doc, "#filter-priority .filter").find((b) => b.dataset.value === "high");
  click(highBtn);
  await settle();
  assert.match(text(ctx.doc, "#task-list"), /高いタスク/);
  assert.ok(!text(ctx.doc, "#task-list").includes("低いタスク"));
  assert.strictEqual(highBtn.getAttribute("aria-pressed"), "true");

  click($(ctx.doc, "#btn-clear-filters"));
  await settle();
  assert.match(text(ctx.doc, "#task-list"), /低いタスク/);
});

test("絞り込み: 条件に合うものが無ければその旨を出す", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "低いタスク", priority: "low", deadline: localInput(3) });
  click($$(ctx.doc, "#filter-priority .filter").find((b) => b.dataset.value === "high"));
  await settle();
  assert.match(text(ctx.doc, "#task-list"), /条件に合うタスクはありません/);
});

// ---- 追加・編集・完了 ----

test("追加: タスク名が空だと保存されずエラーが出る（要件4.7）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "   " });
  assert.strictEqual(activeView(ctx.doc), "view-detail");
  assert.ok(!$(ctx.doc, "#form-errors").classList.contains("hidden"));
  assert.match(text(ctx.doc, "#form-errors"), /タスク名/);
});

test("編集: 変更が一覧へ反映される", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "編集前", deadline: localInput(3) });
  click($(ctx.doc, "#task-list .task"));
  await settle();
  $(ctx.doc, "#f-title").value = "編集後";
  $(ctx.doc, "#task-form").dispatchEvent(new ctx.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  assert.match(text(ctx.doc, "#task-list"), /編集後/);
});

test("完了・アーカイブ: 画面で確認でき、未完了に戻せる（要件5.3）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "完了するタスク", deadline: localInput(3) });
  await addTaskViaUi(ctx, { title: "アーカイブするタスク", deadline: localInput(4) });

  click($(ctx.doc, "#task-list .task"));
  await settle();
  click($(ctx.doc, "#btn-complete"));
  await settle();

  click($(ctx.doc, "#task-list .task"));
  await settle();
  click($(ctx.doc, "#btn-archive"));
  await settle();

  click($(ctx.doc, "#btn-open-archive"));
  await settle();
  assert.strictEqual(activeView(ctx.doc), "view-archive");
  assert.match(text(ctx.doc, "#done-list"), /完了するタスク/);
  assert.match(text(ctx.doc, "#archived-list"), /アーカイブするタスク/);

  click($(ctx.doc, "#done-list .task-check"));
  await settle();
  assert.ok(!text(ctx.doc, "#done-list").includes("完了するタスク"));
});

test("削除ボタンを置かず、アーカイブで代替している（要件4.8）", async () => {
  const { doc } = boot();
  await settle();
  assert.strictEqual($(doc, "#btn-archive") != null, true);
  assert.ok(!$(doc, "#view-detail").textContent.includes("削除"));
});

// ---- 同期 ----

test("同期: 変更すると未保存と表示される（受け入れ条件14の前提）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "未保存のタスク", deadline: localInput(3) });
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "dirty");
  assert.match(text(ctx.doc, "#sync-state"), /未保存/);
  assert.match(text(ctx.doc, "#btn-sync"), /未保存/);
});

test("同期: 更新を押すと保存され、状態表示が変わる（要件5.4）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "保存するタスク", deadline: localInput(3) });
  click($(ctx.doc, "#btn-sync"));
  await settle();
  await settle();
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "saved");
  assert.strictEqual(ctx.app.isDirty(), false);
});

test("同期: 保存した内容を開き直しても残る（受け入れ条件7）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "残るタスク", deadline: localInput(3) });
  click($(ctx.doc, "#btn-sync"));
  await settle();
  await settle();

  const reopened = boot(ctx.store);
  await settle();
  assert.match(text(reopened.doc, "#task-list"), /残るタスク/);
});

test("同期: 未保存のまま閉じようとすると警告する（受け入れ条件14）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "警告されるタスク", deadline: localInput(3) });

  const event = new ctx.window.Event("beforeunload", { cancelable: true });
  ctx.window.dispatchEvent(event);
  // ブラウザは preventDefault と returnValue のどちらでも離脱確認を出す。
  // jsdom の Event には returnValue が無い場合があるので、片方でも立っていればよい。
  assert.ok(
    event.defaultPrevented || event.returnValue === "保存されていません",
    `離脱警告の合図が立っていない（defaultPrevented=${event.defaultPrevented} / returnValue=${event.returnValue}）`
  );
});

test("同期: 保存済みなら警告しない", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: "保存済みタスク", deadline: localInput(3) });
  click($(ctx.doc, "#btn-sync"));
  await settle();
  await settle();

  const event = new ctx.window.Event("beforeunload", { cancelable: true });
  ctx.window.dispatchEvent(event);
  assert.strictEqual(event.defaultPrevented, false);
});

// ---- Google接続（OAuth） ----

// GISライブラリと Sheets API の応答を差し替えて、接続まわりの動きだけを見る。
function stubGoogle(window, { tokenResponse } = {}) {
  const client = {
    callback: null,
    error_callback: null,
    requestAccessToken() {
      this.callback(tokenResponse || { access_token: "test-token", expires_in: 3600 });
    },
  };
  window.google = {
    accounts: { oauth2: { initTokenClient: () => client, revoke: (_t, cb) => cb && cb() } },
  };
  return client;
}

function stubSheetsApi(window, { tabs = ["Tasks"], values = null } = {}) {
  const calls = [];
  window.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || "GET", init });
    if (String(url).includes("fields=sheets.properties.title")) {
      return { ok: true, json: async () => ({ sheets: tabs.map((t) => ({ properties: { title: t } })) }) };
    }
    return { ok: true, json: async () => ({ values: values || [] }) };
  };
  return calls;
}

test("接続: クライアントID未設定なら、その旨を出して読み込みに行かない", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "" });
  await settle();
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "error");
  assert.match(text(ctx.doc, "#sync-state"), /更新失敗/);
  assert.match(text(ctx.doc, "#notice"), /クライアントIDが未設定/);
});

test("接続: 未接続なら「Googleに接続」ボタンが出て、自動では読み込まない", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  assert.ok(!$(ctx.doc, "#btn-connect").classList.contains("hidden"));
  assert.ok($(ctx.doc, "#btn-disconnect").classList.contains("hidden"));
  assert.strictEqual(ctx.app.state.lastLoadedAt, null, "接続前に読み込みへ行かない");
  assert.match(text(ctx.doc, "#notice"), /Googleに接続すると/);
});

// ---- 起動時のローダー ----

test("ローダー: 起動直後は出ていて、アプリの上に重なる", async () => {
  const ctx = boot(new Map(), { splash: { maxMs: 9999 } });
  await settle();
  const splash = $(ctx.doc, "#splash");
  assert.ok(splash, "ローダーが消えている");
  assert.ok(!splash.classList.contains("is-leaving"), "まだ消え始めていない");
});

test("ローダー: 再生が終わったら消える", async () => {
  const ctx = boot(new Map(), { splash: { maxMs: 9999 } });
  await settle();
  const video = $(ctx.doc, "#splash-video");
  video.dispatchEvent(new ctx.window.Event("ended"));
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual($(ctx.doc, "#splash"), null, "再生後も残っている");
});

test("ローダー: 再生できなくても消える（自動再生が拒否される端末がある）", async () => {
  const ctx = boot(new Map(), { splash: { maxMs: 9999 } });
  await settle();
  const video = $(ctx.doc, "#splash-video");
  video.dispatchEvent(new ctx.window.Event("error"));
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual($(ctx.doc, "#splash"), null, "失敗したまま画面を塞いでいる");
});

test("ローダー: 何も起きなくても上限時間で消える", async () => {
  const ctx = boot(new Map(), { splash: { maxMs: 30 } });
  await settle();
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual($(ctx.doc, "#splash"), null, "上限を過ぎても残っている");
});

test("ローダー: 設定で切れる", async () => {
  const ctx = boot(new Map(), { splash: { enabled: false } });
  await settle();
  assert.strictEqual($(ctx.doc, "#splash"), null, "enabled:false でも出ている");
});

test("アカウント指定: 覚えていなければ入力欄を出す", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  assert.ok(!$(ctx.doc, "#account-setup").classList.contains("hidden"),
    "アカウント選択画面を省くための入力欄が出る");
});

test("アカウント指定: 保存すると入力欄が引っ込み、hint として渡される", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();

  $(ctx.doc, "#account-hint").value = "me@example.com";
  click($(ctx.doc, "#btn-save-hint"));
  await settle();

  assert.ok($(ctx.doc, "#account-setup").classList.contains("hidden"), "一度入れたら出さない");
  assert.match(text(ctx.doc, "#notice"), /me@example\.com/);
  assert.strictEqual(
    ctx.app.auth.tokenClientOptions(ctx.app.APP_CONFIG).hint, "me@example.com");
});

test("アカウント指定: 保存だけして接続はしない（ポップアップが塞がれるため）", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  const client = stubGoogle(ctx.window);
  let asked = 0;
  client.requestAccessToken = () => { asked += 1; };

  $(ctx.doc, "#account-hint").value = "me@example.com";
  click($(ctx.doc, "#btn-save-hint"));
  await settle();

  assert.strictEqual(asked, 0, "保存の流れで勝手に認可へ行かない");
  assert.ok(!$(ctx.doc, "#btn-connect").classList.contains("hidden"), "接続ボタンは出したまま");
});

test("アカウント指定: 端末に残るのはアドレスだけで、トークンは保存しない", async () => {
  const state = new Map();
  const ctx = boot(state, { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window, { access_token: "ya29-secret-token", expires_in: 3600 });
  stubSheetsApi(ctx.window);

  $(ctx.doc, "#account-hint").value = "me@example.com";
  click($(ctx.doc, "#btn-save-hint"));
  click($(ctx.doc, "#btn-connect"));
  await settle();

  const saved = [...state.values()].join(" ");
  assert.ok(saved.includes("me@example.com"), "アドレスは覚える");
  assert.ok(!saved.includes("ya29-secret-token"), "トークンは覚えない");
});

test("接続: 押すとトークンを取得し、シートを読み込む（受け入れ条件3・4）", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();

  stubGoogle(ctx.window);
  const header = ["task_id", "project_id", "title", "description", "status", "confirmation",
    "priority", "importance", "urgency", "effort", "deadline", "executor", "autonomy", "blockedBy",
    "nextAction", "definitionOfDone", "sources", "updated", "aiExtracted", "aiGenerated",
    "aiEstimatedFields", "confirmedFields", "createdAt", "updatedAt", "completedAt", "archivedAt", "version"];
  const calls = stubSheetsApi(ctx.window, {
    values: [header, ["t1", "p1", "シートから読んだタスク", "", "未着手", "confirmed",
      "high", "high", "", "medium", "", "本人", "", "[]", "", "", "[]", "", "TRUE", "FALSE",
      "[]", "[]", "", "", "", "", "1"]],
  });

  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();

  assert.strictEqual(ctx.app.auth.isSignedIn(), true);
  assert.match(text(ctx.doc, "#task-list"), /シートから読んだタスク/);
  assert.ok($(ctx.doc, "#btn-connect").classList.contains("hidden"));
  assert.ok(!$(ctx.doc, "#btn-disconnect").classList.contains("hidden"));
  assert.ok(calls.some((c) => c.url.includes("1g6Of2Ve2WaCeVkLt74IR1K3M-9z-w8jdQ9hiON4v2Rs")), "設定したシートを見に行く");
  assert.ok(calls.some((c) => c.init && c.init.headers.Authorization === "Bearer test-token"), "トークンを添えて呼ぶ");
});

test("接続: 更新を押すとシートへ書き戻す（受け入れ条件5）", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window);
  const calls = stubSheetsApi(ctx.window, { values: [] });

  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();

  await addTaskViaUi(ctx, { title: "書き戻すタスク", deadline: localInput(3) });
  click($(ctx.doc, "#btn-sync"));
  await settle(); await settle(); await settle();

  // [変更 2026-07-28] タブ全体のPUTをやめ、行単位の更新と追加に変えた。
  // 全面PUTは列が1つずれただけで正本を壊すため。
  // 空シートなので見出し行のPUTは1回だけ許される。行データはそこに含めない。
  const puts = calls.filter((c) => c.method === "PUT");
  assert.ok(puts.length <= 1, "タブ全体を繰り返しPUTで置き換えない");
  if (puts.length === 1) {
    assert.ok(!/書き戻すタスク/.test(puts[0].init.body), "PUTは見出し行だけ");
  }
  const write = calls.find((c) => c.method === "POST" && /:append|values:batchUpdate/.test(c.url));
  assert.ok(write, "行単位でシートへ書き込む");
  assert.match(write.url, /valueInputOption=RAW/);
  assert.match(write.init.body, /書き戻すタスク/);
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "saved");
});

test("接続: 想定のタブが無ければ代用せず止まる", async () => {
  // [変更 2026-07-28] 以前は先頭のタブで代用していた。tasks -> Tasks の移行時に
  // 列構成の違うシートを掴んで全面上書きしかけたため、止まる挙動に変えた。
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window);
  stubSheetsApi(ctx.window, { tabs: ["AI Todo タスク正本"], values: [] });

  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();
  assert.match(text(ctx.doc, "#notice"), /タブが見つかりません/);
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "error");
});

test("接続: 見出しが別スキーマなら読み込まず、書き込みにも行かない", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window);
  const calls = stubSheetsApi(ctx.window, {
    values: [["id", "title", "weight"], ["t1", "旧スキーマの行", "light"]],
  });

  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();

  assert.match(text(ctx.doc, "#notice"), /見出し行が想定と違います/);
  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "error");
  assert.ok(!calls.some((c) => c.method === "PUT" || c.method === "POST"), "書き込みへ進まない");
});

test("接続: 切断するとボタンが戻る", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window);
  stubSheetsApi(ctx.window, { values: [] });

  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();
  click($(ctx.doc, "#btn-disconnect"));
  await settle();

  assert.strictEqual(ctx.app.auth.isSignedIn(), false);
  assert.ok(!$(ctx.doc, "#btn-connect").classList.contains("hidden"));
});

test("接続: 失敗しても未保存の変更を捨てない（受け入れ条件8）", async () => {
  const ctx = boot(new Map(), { authMode: "oauth", clientId: "dummy.apps.googleusercontent.com" });
  await settle();
  stubGoogle(ctx.window);
  stubSheetsApi(ctx.window, { values: [] });
  click($(ctx.doc, "#btn-connect"));
  await settle(); await settle(); await settle();

  await addTaskViaUi(ctx, { title: "失敗しても残るタスク", deadline: localInput(3) });
  ctx.window.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  click($(ctx.doc, "#btn-sync"));
  await settle(); await settle(); await settle();

  assert.strictEqual($(ctx.doc, "#sync-state").dataset.state, "error");
  assert.match(text(ctx.doc, "#task-list"), /失敗しても残るタスク/);
});

// ---- フォルダ表示（ツリー） ----

function seedTree(ctx) {
  ctx.app.state.projects = [
    ctx.app.makeProject({ id: "p1", name: "大タスクA", category: "E-趣味",
      source: "タスク/E-趣味/AIToDoアプリ/大タスクA/_概要.md", progress: 0.5, status: "進行中" }),
    ctx.app.makeProject({ id: "p2", name: "大タスクB", category: "A-就活",
      source: "タスク/A-就活/大タスクB/_概要.md" }),
  ];
  ctx.app.state.tasks = [
    ctx.app.makeTask({ id: "t1", projectId: "p1", title: "Aの小タスク" }),
    ctx.app.makeTask({ id: "t2", projectId: "p1", title: "Aの小タスク2" }),
    ctx.app.makeTask({ id: "t3", projectId: "p2", title: "Bの小タスク" }),
  ];
  click($(ctx.doc, '#filter-group-mode [data-mode="folder"]'));
}

test("まとめ方: 期限順とフォルダ順が選択肢として並ぶ", async () => {
  // 1つのボタンで交互に切り替える作りだと、ラベルが現在の状態か
  // 押した結果かが読み取れず、切り替えられることに気づけなかった。
  const ctx = boot();
  await settle();
  const btns = $$(ctx.doc, "#filter-group-mode [data-mode]");
  assert.deepStrictEqual(btns.map((b) => b.textContent), ["期限順", "フォルダ順"]);
  assert.strictEqual(btns[0].getAttribute("aria-pressed"), "true", "既定は期限順");

  click(btns[1]);
  assert.strictEqual(btns[1].getAttribute("aria-pressed"), "true");
  assert.strictEqual(btns[0].getAttribute("aria-pressed"), "false");
});

test("ツリー: 大タスクが未同期なら理由を出す", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.projects = [];
  ctx.app.state.tasks = [ctx.app.makeTask({ id: "t1", title: "所属なしのタスク" })];
  click($(ctx.doc, '#filter-group-mode [data-mode="folder"]'));
  assert.match(text(ctx.doc, "#task-list"), /同期を実行してください/);
});

test("ツリー: 分類フォルダごとに分かれ、大タスクは畳まれている", async () => {
  const ctx = boot();
  await settle();
  seedTree(ctx);

  const folders = $$(ctx.doc, "#task-list .folder-group");
  assert.deepStrictEqual(folders.map((f) => f.querySelector("h2").textContent), ["E-趣味", "A-就活"]);
  assert.ok(folders.every((f) => f.open), "分類フォルダは既定で開く");

  const projects = $$(ctx.doc, "#task-list .project-group");
  assert.strictEqual(projects.length, 2);
  assert.ok(projects.every((g) => !g.open), "大タスクは既定で畳む");
});

test("ツリー: 畳んだままでも件数と進捗が見える", async () => {
  const ctx = boot();
  await settle();
  seedTree(ctx);

  const first = $(ctx.doc, "#task-list .project-group");
  const summary = first.querySelector("summary").textContent;
  assert.match(summary, /2件/, "小タスクの件数");
  assert.match(summary, /50%/, "進捗");
  assert.match(summary, /進行中/, "状態");
  assert.match(first.querySelector(".project-path").textContent, /AIToDoアプリ/, "中間フォルダをパンくずで出す");
});

test("ツリー: 開閉が端末に残り、再描画しても保たれる", async () => {
  const shared = new Map();
  const ctx = boot(shared);
  await settle();
  seedTree(ctx);

  const g = $(ctx.doc, "#task-list .project-group");
  g.open = true;
  g.dispatchEvent(new ctx.window.Event("toggle"));
  ctx.app.render();
  assert.ok($(ctx.doc, "#task-list .project-group").open, "再描画しても開いたまま");

  const saved = JSON.parse(shared.get("aiTodo.openGroups"));
  assert.ok(saved.includes("project:p1"), "開いた大タスクを覚える");
});

test("ツリー: AI提案もフォルダ分けされ、確定タスクと開閉が独立している", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.projects = [
    ctx.app.makeProject({ id: "p1", name: "大タスクA", category: "E-趣味",
      source: "タスク/E-趣味/大タスクA/_概要.md" }),
  ];
  ctx.app.state.tasks = [
    ctx.app.makeTask({ id: "t1", projectId: "p1", title: "確定のタスク" }),
    ctx.app.makeTask({ id: "t2", projectId: "p1", title: "提案のタスク",
      confirmation: "proposed", aiGenerated: true }),
  ];
  click($(ctx.doc, '#filter-group-mode [data-mode="folder"]'));

  const proposalFolders = $$(ctx.doc, "#proposal-list .folder-group");
  assert.strictEqual(proposalFolders.length, 1, "提案もフォルダに分かれる");
  assert.strictEqual(proposalFolders[0].querySelector("h2").textContent, "E-趣味");
  assert.ok(!proposalFolders[0].open, "提案は数が多いので既定で畳む");
  assert.ok($(ctx.doc, "#task-list .folder-group").open, "確定タスク側は既定で開く");

  assert.match(text(ctx.doc, "#proposal-list"), /採用/, "提案の操作は採用のまま");
  assert.match(text(ctx.doc, "#task-list"), /完了/, "確定タスクの操作は完了のまま");
  assert.ok(!text(ctx.doc, "#task-list").includes("提案のタスク"), "確定側に混ざらない");
});

test("ツリー: 期限順に戻すと提案は平たい一覧に戻る", async () => {
  const ctx = boot();
  await settle();
  ctx.app.state.tasks = [
    ctx.app.makeTask({ id: "t2", title: "提案のタスク", confirmation: "proposed", aiGenerated: true }),
  ];
  click($(ctx.doc, '#filter-group-mode [data-mode="deadline"]'));
  assert.strictEqual($$(ctx.doc, "#proposal-list .folder-group").length, 0);
  assert.match(text(ctx.doc, "#proposal-list"), /提案のタスク/);
});

// ---- 安全性 ----

test("表示: タスク名のHTMLがそのまま実行されない（要件7.3）", async () => {
  const ctx = boot();
  await settle();
  await addTaskViaUi(ctx, { title: '<img src=x onerror="window.__xss=1">', deadline: localInput(3) });
  assert.strictEqual(ctx.doc.querySelectorAll("#task-list img").length, 0);
  assert.strictEqual(ctx.window.__xss, undefined);
});

// ---- 実行 ----

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      failures.push({ name: t.name, err });
    }
  }

  bootedWindows.forEach((w) => {
    try { w.close(); } catch { /* 結果には影響しない */ }
  });

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
  process.exit(0);
})();
