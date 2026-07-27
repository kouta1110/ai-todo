// gas/ai_todo_sync.gs のロジックを、Apps Scriptを使わずに検証する。
//   実行: node tests/gas.test.js
//
// SpreadsheetApp などを最小限のスタブで置き換えて vm に読み込む。
// 正本を壊さない保護ルールが実際に効いているかを、貼り付ける前に確認するためのもの。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "gas/ai_todo_sync.gs"), "utf8");

const HEADER = [
  "id", "title", "description", "priority", "weight", "deadline", "urgency", "status",
  "decisionStatus", "sources", "aiExtracted", "aiGenerated", "aiEstimatedFields",
  "confirmedFields", "createdAt", "updatedAt", "completedAt", "archivedAt", "version",
];

// ---- Apps Script のスタブ ----

function makeSheet(rows) {
  const values = [HEADER.slice(), ...rows];
  return {
    values,
    getName: () => "tasks",
    getDataRange: () => ({ getValues: () => values.map((r) => r.slice()) }),
    getRange(row, col, numRows, numCols) {
      return {
        setValues(block) {
          block.forEach((r, i) => {
            const target = row - 1 + i;
            while (values.length <= target) values.push(new Array(HEADER.length).fill(""));
            for (let c = 0; c < numCols; c += 1) values[target][col - 1 + c] = r[c];
          });
        },
      };
    },
  };
}

function load(sheet) {
  const logs = [];
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet }) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text) => ({ setMimeType: () => ({ __text: text }) }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: (m) => logs.push(String(m)) },
    JSON, Date, Number, String, Object, Math, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "ai_todo_sync.gs" });
  const api = vm.runInContext(
    "({ CFG, upsert, readAll, getSheet, doGet, doPost, testReadAll, isAuthorized })",
    sandbox
  );
  return { api, logs, sandbox };
}

// 行を組み立てる（既定値つき）
function row(overrides = {}) {
  const base = {
    id: "", title: "", description: "", priority: "medium", weight: "medium", deadline: "",
    urgency: "", status: "todo", decisionStatus: "confirmed", sources: "", aiExtracted: "FALSE",
    aiGenerated: "FALSE", aiEstimatedFields: "", confirmedFields: "", createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z", completedAt: "", archivedAt: "", version: "1",
  };
  const merged = { ...base, ...overrides };
  return HEADER.map((h) => String(merged[h]));
}

const at = (sheet, id) => {
  const i = sheet.values.findIndex((r) => r[0] === id);
  if (i < 0) return null;
  const obj = {};
  HEADER.forEach((h, c) => (obj[h] = sheet.values[i][c]));
  return obj;
};

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ================= 認証 =================

test("認証: tokenが違えば拒否する", () => {
  const { api } = load(makeSheet([]));
  assert.strictEqual(api.isAuthorized("まちがい"), false);
  assert.strictEqual(api.isAuthorized(api.CFG.TOKEN), true);
  assert.strictEqual(api.isAuthorized(undefined), false);
  assert.strictEqual(api.isAuthorized(""), false);
});

test("認証: tokenが無いGETは中身を返さない", () => {
  const { api } = load(makeSheet([row({ id: "t1", title: "秘密のタスク" })]));
  const res = JSON.parse(api.doGet({ parameter: {} }).__text);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "unauthorized");
  assert.ok(!JSON.stringify(res).includes("秘密のタスク"));
});

// ================= 読み取り =================

test("読み取り: 配列列と真偽値列を型どおりに戻す", () => {
  const sheet = makeSheet([
    row({ id: "t1", title: "A", sources: '["50_活動/x.md","60_ログ/y.md"]', aiExtracted: "TRUE",
          aiEstimatedFields: '["urgency"]', confirmedFields: '["priority"]', version: "3" }),
  ]);
  const { api } = load(sheet);
  const t = api.readAll(api.getSheet()).tasks[0];
  assert.deepStrictEqual(Array.from(t.sources), ["50_活動/x.md", "60_ログ/y.md"]);
  assert.strictEqual(t.aiExtracted, true);
  assert.strictEqual(t.aiGenerated, false);
  assert.deepStrictEqual(Array.from(t.confirmedFields), ["priority"]);
  assert.strictEqual(t.version, 3);
});

test("読み取り: 空行を読み飛ばす", () => {
  const sheet = makeSheet([new Array(HEADER.length).fill(""), row({ id: "t1", title: "A" })]);
  const { api } = load(sheet);
  assert.strictEqual(api.readAll(api.getSheet()).tasks.length, 1);
});

test("読み取り: 壊れた配列列でも落ちない", () => {
  const sheet = makeSheet([row({ id: "t1", title: "A", sources: "これはJSONではない" })]);
  const { api } = load(sheet);
  assert.deepStrictEqual(Array.from(api.readAll(api.getSheet()).tasks[0].sources), ["これはJSONではない"]);
});

// ================= 新規追加 =================

test("新規: 行が増え、createdAt と version が設定される", () => {
  const sheet = makeSheet([]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "新しいタスク", priority: "high", sources: ["50_活動/x.md"] }], false);

  assert.strictEqual(r.summary.created, 1);
  const saved = at(sheet, "a1");
  assert.strictEqual(saved.title, "新しいタスク");
  assert.strictEqual(saved.priority, "high");
  assert.strictEqual(saved.version, "1");
  assert.strictEqual(saved.sources, '["50_活動/x.md"]');
  assert.ok(saved.createdAt);
});

test("新規: confirmedFields は空で作る（本人はまだ何も確認していない）", () => {
  const sheet = makeSheet([]);
  const { api } = load(sheet);
  api.upsert([{ id: "a1", title: "A", confirmedFields: ["priority", "title"] }], false);
  assert.strictEqual(at(sheet, "a1").confirmedFields, "", "送信された confirmedFields は無視する");
});

test("新規: 複数件をまとめて追加できる", () => {
  const sheet = makeSheet([]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "A" }, { id: "a2", title: "B" }, { id: "a3", title: "C" }], false);
  assert.strictEqual(r.summary.created, 3);
  assert.ok(at(sheet, "a3"));
});

// ================= 更新と保護 =================

test("更新: 変わった列だけ書き換え、version が+1される", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", priority: "low", version: "4" })]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "A", priority: "high" }], false);

  assert.strictEqual(r.summary.updated, 1);
  assert.deepStrictEqual(Array.from(r.updated[0].changed), ["priority"]);
  const saved = at(sheet, "a1");
  assert.strictEqual(saved.priority, "high");
  assert.strictEqual(saved.version, "5");
});

test("更新: 本人が確定した列は上書きしない（受け入れ条件11）", () => {
  const sheet = makeSheet([
    row({ id: "a1", title: "A", priority: "high", weight: "light", confirmedFields: '["priority"]', version: "2" }),
  ]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", priority: "low", weight: "heavy" }], false);

  const saved = at(sheet, "a1");
  assert.strictEqual(saved.priority, "high", "確定済みの優先順位は守られる");
  assert.strictEqual(saved.weight, "heavy", "確定していない重さは更新される");
  assert.deepStrictEqual(Array.from(r.updated[0].protectedColumns), ["priority"], "据え置いた列を報告する");
});

test("更新: id / createdAt / version を送っても書き換わらない", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", createdAt: "2026-07-01T00:00:00Z", version: "2" })]);
  const { api } = load(sheet);
  api.upsert([{ id: "a1", title: "B", createdAt: "1999-01-01T00:00:00Z", version: 99 }], false);

  const saved = at(sheet, "a1");
  assert.strictEqual(saved.createdAt, "2026-07-01T00:00:00Z");
  assert.strictEqual(saved.version, "3", "送信値ではなく+1される");
  assert.strictEqual(saved.title, "B");
});

test("更新: 中身が同じなら変更なしとして扱い、versionも動かさない", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", priority: "high", version: "7" })]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "A", priority: "high" }], false);

  assert.strictEqual(r.summary.unchanged, 1);
  assert.strictEqual(r.summary.updated, 0);
  assert.strictEqual(at(sheet, "a1").version, "7");
});

test("更新: 配列列は順序が違っても同じとみなす", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", sources: '["b.md","a.md"]' })]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", sources: ["a.md", "b.md"] }], false);
  assert.strictEqual(r.summary.unchanged, 1, "並び順だけの違いで更新扱いにしない");
});

test("更新: 送っていない列は触らない", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", description: "残すメモ", priority: "low" })]);
  const { api } = load(sheet);
  api.upsert([{ id: "a1", priority: "high" }], false);
  assert.strictEqual(at(sheet, "a1").description, "残すメモ");
});

// ================= 完了・アーカイブの保護 =================

test("保護: 完了済みタスクを未完了へ戻さない（要件4.8）", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", status: "done", completedAt: "2026-07-20T00:00:00Z" })]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "A", status: "todo" }], false);

  assert.strictEqual(r.summary.skipped, 1);
  assert.match(r.skipped[0].reason, /完了済み/);
  assert.strictEqual(at(sheet, "a1").status, "done");
});

test("保護: アーカイブ済みタスクを復活させない（要件4.8）", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", status: "archived", archivedAt: "2026-07-20T00:00:00Z" })]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "A", status: "todo" }], false);

  assert.strictEqual(r.summary.skipped, 1);
  assert.match(r.skipped[0].reason, /アーカイブ済み/);
  assert.strictEqual(at(sheet, "a1").status, "archived");
});

test("状態: todo → done にすると completedAt が入る", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", status: "todo" })]);
  const { api } = load(sheet);
  api.upsert([{ id: "a1", status: "done" }], false);
  const saved = at(sheet, "a1");
  assert.strictEqual(saved.status, "done");
  assert.ok(saved.completedAt, "完了日時が記録される");
});

// ================= dryRun =================

test("dryRun: シートを書き換えずに判定だけ返す", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A", priority: "low" })]);
  const before = JSON.stringify(sheet.values);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", priority: "high" }, { id: "a2", title: "新規" }], true);

  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.summary.updated, 1);
  assert.strictEqual(r.summary.created, 1);
  assert.strictEqual(JSON.stringify(sheet.values), before, "シートは1文字も変わらない");
});

// ================= エラー =================

test("エラー: id が無い項目はエラーに入れ、他は処理を続ける", () => {
  const sheet = makeSheet([]);
  const { api } = load(sheet);
  const r = api.upsert([{ title: "idなし" }, { id: "a1", title: "正常" }], false);

  assert.strictEqual(r.summary.errors, 1);
  assert.strictEqual(r.summary.created, 1);
  assert.match(r.errors[0].reason, /id/);
  assert.ok(at(sheet, "a1"));
});

test("エラー: 同じidが1回の送信に複数あれば2件目以降を弾く", () => {
  const sheet = makeSheet([]);
  const { api } = load(sheet);
  const r = api.upsert([{ id: "a1", title: "1つ目" }, { id: "a1", title: "2つ目" }], false);

  assert.strictEqual(r.summary.created, 1);
  assert.strictEqual(r.summary.errors, 1);
  assert.strictEqual(at(sheet, "a1").title, "1つ目");
});

test("エラー: tasks が空なら受け付けない", () => {
  const { api } = load(makeSheet([]));
  const res = JSON.parse(
    api.doPost({ postData: { contents: JSON.stringify({ token: api.CFG.TOKEN, tasks: [] }) } }).__text
  );
  assert.strictEqual(res.ok, false);
});

// ================= 設置確認 =================

test("設置確認: testReadAll が見出しと件数をログに出す", () => {
  const sheet = makeSheet([row({ id: "a1", title: "A" })]);
  const { api, logs } = load(sheet);
  api.testReadAll();
  assert.ok(logs.some((l) => l.includes("見出し行")));
  assert.ok(logs.some((l) => l.includes("タスク件数: 1")));
});

test("設置確認: TOKEN が初期値のままなら警告する", () => {
  const { api, logs } = load(makeSheet([]));
  api.testReadAll();
  assert.ok(logs.some((l) => l.includes("CFG.TOKEN")), "デプロイ前に気づけるようにする");
});

test("整合: 列の並びがアプリ側（js/sheets.js）と一致している", () => {
  const appSource = fs.readFileSync(path.join(root, "js/sheets.js"), "utf8");
  const block = appSource.match(/const SHEET_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(block, "js/sheets.js の SHEET_FIELDS が見つからない");
  const fields = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(fields, HEADER, "アプリとGASで列が食い違うと別タスク扱いになる");
});

// ================= sync.sh =================

// 2026-07-27に踏んだ不具合の再発防止。
// `echo "$X" | python3 - <<'PY'` と書くと、ヒアドキュメントがパイプを上書きして
// python が標準入力からプログラムを読み切ってしまい、sys.stdin.read() が空になる。
// 応答が届いていても「応答をJSONとして読めませんでした」に化けるので、必ず引数で渡す。
test("sync.sh: 応答を標準入力ではなくファイル引数で python に渡している", () => {
  const sh = fs.readFileSync(path.join(root, "gas/sync.sh"), "utf8");
  assert.ok(
    !/\|\s*python3\s+-\s*<<'?PY/.test(sh),
    "ヒアドキュメントとパイプの併用は応答を読み落とす"
  );
  assert.ok(
    !/sys\.stdin\.read\(\)/.test(sh),
    "ヒアドキュメントでプログラムを渡す間は sys.stdin は使えない"
  );
  assert.ok(
    /python3\s+-\s+"\$RESPONSE"/.test(sh),
    "応答ファイルのパスを argv で渡すこと"
  );
});

// 同じく2026-07-27。-L と -X POST の併用でリダイレクト先へPOSTが飛び、405になった。
test("sync.sh: curl に -X POST を付けていない", () => {
  const sh = fs.readFileSync(path.join(root, "gas/sync.sh"), "utf8");
  const curlLines = sh.split("\n").filter((l) => /^\s*[A-Z_]*=?"?\$?\(?curl |curl /.test(l));
  assert.ok(curlLines.length > 0, "curl の呼び出しが見当たらない");
  curlLines.forEach((line) => {
    assert.ok(
      !/-X\s+POST/.test(line),
      "-X POST はリダイレクト先にもPOSTを強制し405になる。-d だけで足りる"
    );
  });
  assert.ok(/curl\s+-sL/.test(sh), "Apps Script のリダイレクトを追うので -L は必要");
  assert.ok(/-d\s+@"\$BODY"/.test(sh), "-d でボディを渡せば1回目は自動でPOSTになる");
});

test("sync.sh: 一時ファイルを後始末している", () => {
  const sh = fs.readFileSync(path.join(root, "gas/sync.sh"), "utf8");
  const traps = [...sh.matchAll(/trap\s+'rm -f ([^']*)'\s+EXIT/g)].map((m) => m[1]);
  assert.ok(traps.length > 0, "mktemp した一時ファイルに trap が要る");
  assert.ok(
    traps[traps.length - 1].includes('"$BODY"') && traps[traps.length - 1].includes('"$RESPONSE"'),
    "最後の trap が両方の一時ファイルを消すこと（trap は上書きされる）"
  );
});

// ================= 実行 =================

tests.forEach(({ name, fn }) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
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
