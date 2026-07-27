// Apps Script API を最小限スタブして ai_todo_sync.gs をNodeで実行する検証ハーネス
const fs = require('fs');

// ---- 疑似スプレッドシート ----
class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.frozen = 0; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  clear() { this.data = []; return this; }
  setFrozenRows(n) { this.frozen = n; return this; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this._width(); }
  getDataRange() { return this._range(1, 1, Math.max(this.data.length, 0), this._width()); }
  _width() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) { return this._range(row, col, numRows, numCols); }
  _range(row, col, numRows, numCols) {
    const sh = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = sh.data[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        vals.forEach((line, r) => {
          const target = row - 1 + r;
          if (!sh.data[target]) sh.data[target] = [];
          line.forEach((v, c) => { sh.data[target][col - 1 + c] = v; });
        });
        return this;
      }
    };
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheets() { return this.sheets.slice(); }
  // 実物の Apps Script と同じく大文字小文字を区別しない
  getSheetByName(n) {
    const t = String(n).toLowerCase();
    return this.sheets.find(s => s.name.toLowerCase() === t) || null;
  }
  // Google スプレッドシートは大小違いの同名シートを作れない
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error('シート名が重複: ' + n);
    const s = new FakeSheet(n); this.sheets.push(s); return s;
  }
}

const SS = new FakeSpreadsheet();

global.SpreadsheetApp = { getActiveSpreadsheet: () => SS };
global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } })
};
global.Utilities = {
  formatDate: (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+09:00')
};
const logs = [];
global.Logger = { log: (m) => logs.push(String(m)) };

// ---- 読み込み ----
// gas/ は .gitignore 対象（Vaultのパスを含む手元専用フォルダ）。
// クローンしただけの環境には無いので、その場合はスキップして落とさない。
const path_ = require("path");
const GS = process.argv[2] || path_.join(__dirname, "..", "gas", "ai_todo_sync.gs");
const PAYLOAD = process.argv[3] || path_.join(__dirname, "..", "gas", "payload_sample.json");
if (!fs.existsSync(GS) || !fs.existsSync(PAYLOAD)) {
  console.log("skip: gas/ が無いため GAS のテストを飛ばします");
  console.log("  " + GS);
  console.log("  引数で渡すこともできます: node tests/gas.test.js <ai_todo_sync.gs> <payload.json>");
  console.log("\npass=0 fail=0");
  process.exit(0);
}
const src = fs.readFileSync(GS, "utf8");
eval(src);

// ---- ヘルパ ----
const post = (body) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const get = (p) => JSON.parse(doGet({ parameter: p }).getContent());
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

const payload = JSON.parse(fs.readFileSync(PAYLOAD, "utf8"));
const TOKEN = CFG.TOKEN;

console.log('\n== 1. 認証 ==');
check('tokenが違えば拒否', post({ token: 'wrong', tasks: [] }).error === 'invalid token');
check('GETもtokenを見る', get({ token: 'wrong' }).error === 'invalid token');

console.log('\n== 2. 旧シートからの移行 ==');
// 旧スキーマのtasksシートを用意
const legacyCols = ['id','title','description','priority','weight','deadline','urgency','status',
  'decisionStatus','sources','aiExtracted','aiGenerated','aiEstimatedFields','confirmedFields',
  'createdAt','updatedAt','completedAt','archivedAt','version'];
const legacy = SS.insertSheet('tasks');
legacy.getRange(1,1,1,legacyCols.length).setValues([legacyCols]);
legacy.getRange(2,1,3,legacyCols.length).setValues([
  ['activity-20260726-001','旧・確定済みタスク','メモ','high','heavy','2026-08-01T23:59:59+09:00','high',
   'todo','confirmed','["50_活動/59.md"]',true,false,'["urgency"]','["priority"]',
   '2026-07-26T10:00:00+09:00','2026-07-26T10:00:00+09:00','','',3],
  ['activity-20260726-009','旧・完了済みタスク','','medium','light','','',
   'done','confirmed','[]',true,false,'[]','[]',
   '2026-07-26T10:00:00+09:00','2026-07-27T10:00:00+09:00','2026-07-27T10:00:00+09:00','',2],
  ['activity-20260726-010','旧・アーカイブ済み','','low','light','','',
   'archived','proposed','[]',true,true,'[]','[]',
   '2026-07-26T10:00:00+09:00','2026-07-27T10:00:00+09:00','','2026-07-27T11:00:00+09:00',1],
]);
migrateLegacySheet();
const tasksSheet = SS.getSheetByName('Tasks');
const exactNames = () => SS.getSheets().map(s => s.getName());
check('tasksシートがTasksへリネームされた',
      exactNames().includes('Tasks') && !exactNames().includes('tasks'), exactNames());
check('Projectsシートが作られた', !!SS.getSheetByName('Projects'));
check('見出しが新列定義と一致', JSON.stringify(tasksSheet.data[0]) === JSON.stringify(TASK_COLUMNS),
      tasksSheet.data[0]);
const afterMigrate = readSheet_(tasksSheet, TASK_COLUMNS);
const m1 = afterMigrate.find(r => r.task_id === 'activity-20260726-001');
check('id -> task_id', !!m1);
check('weight(heavy) -> effort', m1.effort === 'heavy', m1.effort);
check('decisionStatus -> confirmation', m1.confirmation === 'confirmed', m1.confirmation);
check('status todo -> 未着手', m1.status === '未着手', m1.status);
check('confirmedFieldsが新列名へ読み替え(priority)', JSON.stringify(m1.confirmedFields) === '["priority"]',
      m1.confirmedFields);
check('sources配列が保持', JSON.stringify(m1.sources) === '["50_活動/59.md"]', m1.sources);
check('versionが保持', Number(m1.version) === 3, m1.version);
const m2 = afterMigrate.find(r => r.task_id === 'activity-20260726-009');
check('status done -> 完了', m2.status === '完了', m2.status);
check('completedAtが保持', String(m2.completedAt).indexOf('2026-07-27') === 0, m2.completedAt);
const m3 = afterMigrate.find(r => r.task_id === 'activity-20260726-010');
check('status archived -> キャンセル', m3.status === 'キャンセル', m3.status);
check('archivedAtが保持', String(m3.archivedAt).indexOf('2026-07-27') === 0, m3.archivedAt);
// 実物の getSheetByName は大小を区別しないため、tasks/Tasks が同一シートを指す。
// 名前ではなく見出し行で移行済みを判定できているか。
let reran = null;
try { migrateLegacySheet(); } catch (e) { reran = String(e.message || e); }
check('2回目の移行がエラーにならない', reran === null, reran);
check('2回目で行が消えない', readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).length === 3,
      readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).length);
check('シートが増殖しない', SS.getSheets().filter(s => /^tasks$/i.test(s.getName())).length === 1,
      SS.getSheets().map(s => s.getName()));

console.log('\n== 3. dryRunは書き込まない ==');
const rowsBefore = SS.getSheetByName('Tasks').data.length;
const dry = post({ token: TOKEN, dryRun: true, projects: payload.projects, tasks: payload.tasks });
check('ok', dry.ok === true, dry);
check('dryRunフラグが返る', dry.dryRun === true);
check('シート行数が変わらない', SS.getSheetByName('Tasks').data.length === rowsBefore);
check('created件数が出る', dry.tasks.created > 0, dry.tasks);
check('token未指定なら既定でdryRun',
      post({ token: TOKEN, tasks: [] }).dryRun === true);

console.log('\n== 4. 本反映 ==');
const live = post({ token: TOKEN, dryRun: false, projects: payload.projects, tasks: payload.tasks });
check('projects created = ' + live.projects.created, live.projects.created === payload.projects.length,
      live.projects);
check('tasks created = ' + live.tasks.created,
      live.tasks.created === payload.tasks.filter(t => !['activity-20260726-001','activity-20260726-009','activity-20260726-010'].includes(t.task_id)).length,
      live.tasks);
const stored = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS);
check('全件がシートに載る', stored.length >= payload.tasks.length, stored.length);
const sample = stored.find(r => r.task_id === 'task-ai-todo-sync-schema-001');
const sampleIn = payload.tasks.find(t => t.task_id === 'task-ai-todo-sync-schema-001');
check('日本語statusがそのまま入る（todo/doneへ変換しない）',
      sample.status === sampleIn.status && /^(未着手|進行中|保留|完了|キャンセル)$/.test(sample.status),
      [sampleIn.status, sample.status]);
check('blockedByが配列で戻る', Array.isArray(sample.blockedBy), sample.blockedBy);
check('aiEstimatedFieldsが配列で戻る', Array.isArray(sample.aiEstimatedFields), sample.aiEstimatedFields);
check('createdAt/versionが付く', !!sample.createdAt && Number(sample.version) === 1, [sample.createdAt, sample.version]);
const multi = stored.find(r => r.blockedBy.length > 1);
check('カンマ区切りblocked_byが複数要素に', !!multi, multi && multi.blockedBy);

console.log('\n== 5. 冪等性 ==');
const again = post({ token: TOKEN, dryRun: false, projects: payload.projects, tasks: payload.tasks });
check('2回目は全件unchanged', again.tasks.unchanged === payload.tasks.length && again.tasks.updated === 0,
      again.tasks);
check('projectsも全件unchanged', again.projects.unchanged === payload.projects.length, again.projects);

console.log('\n== 6. 保護 ==');
// confirmedFields に priority が入っている行を狙う
const target = payload.tasks.find(t => t.task_id === 'activity-20260726-001');
const before = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'activity-20260726-001');
const r6 = post({ token: TOKEN, dryRun: false, tasks: [
  Object.assign({}, target || {}, { task_id: 'activity-20260726-001', priority: 'low', title: '変更後タイトル' })
]});
const after = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'activity-20260726-001');
check('confirmedFieldsのpriorityは据え置き', after.priority === before.priority, [before.priority, after.priority]);
check('保護外のtitleは更新される', after.title === '変更後タイトル', after.title);
check('protectedが報告される', JSON.stringify(r6.details.tasks[0].protected || []).includes('priority'),
      r6.details.tasks[0]);
check('versionが+1', Number(after.version) === Number(before.version) + 1, [before.version, after.version]);

// 完了行を未着手へ戻そうとする
const doneBefore = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'activity-20260726-009');
post({ token: TOKEN, dryRun: false, tasks: [{ task_id: 'activity-20260726-009', status: '未着手', title: 'X' }]});
const doneAfter = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'activity-20260726-009');
check('完了行は未着手へ戻らない', doneAfter.status === '完了', doneAfter.status);
check('completedAtが消えない', doneAfter.completedAt === doneBefore.completedAt);
// アーカイブ済み行
post({ token: TOKEN, dryRun: false, tasks: [{ task_id: 'activity-20260726-010', status: '進行中' }]});
const archAfter = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'activity-20260726-010');
check('アーカイブ済み行も戻らない', archAfter.status === 'キャンセル', archAfter.status);

console.log('\n== 7. 完了への遷移 ==');
post({ token: TOKEN, dryRun: false, tasks: [{ task_id: 'task-ai-todo-sync-schema-001', status: '完了' }]});
const closed = readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).find(r => r.task_id === 'task-ai-todo-sync-schema-001');
check('status=完了になる', closed.status === '完了', closed.status);
check('completedAtが自動で入る', !!closed.completedAt, closed.completedAt);

console.log('\n== 8. 異常系 ==');
const bad = post({ token: TOKEN, dryRun: true, tasks: [
  { title: 'IDなし' },
  { task_id: 'dup-1', title: 'A' },
  { task_id: 'dup-1', title: 'B' }
]});
check('task_id空はerror', bad.tasks.errors >= 1, bad.tasks);
check('ペイロード内重複もerror', bad.details.tasks.some(d => d.reason === 'ペイロード内でIDが重複'), bad.details.tasks);
check('壊れたJSONを弾く',
      JSON.parse(doPost({ postData: { contents: '{oops' } }).getContent()).error === 'invalid JSON body');
const orphan = post({ token: TOKEN, dryRun: true, tasks: [{ task_id: 'x-1', project_id: 'project-存在しない' }]});
check('存在しないproject_idを警告', orphan.warnings.orphanProjectRefs.length === 1, orphan.warnings);
const payloadIds = new Set(payload.tasks.map(t => t.task_id));
const expectedOrphans = ['activity-20260726-001','activity-20260726-009','activity-20260726-010']
  .filter(id => !payloadIds.has(id));
check('ペイロードに無い行を報告(削除しない)',
      again.warnings.notInPayload.tasks.length === expectedOrphans.length &&
      expectedOrphans.every(id => again.warnings.notInPayload.tasks.includes(id)),
      again.warnings.notInPayload.tasks);
check('ペイロードに無い行が消えていない',
      expectedOrphans.every(id => readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS)
        .some(r => r.task_id === id)));

console.log('\n== 9. GET ==');
const g = get({ token: TOKEN });
check('ok', g.ok === true);
check('projects/tasksの両方が返る', Array.isArray(g.projects) && Array.isArray(g.tasks));
check('件数が一致', g.counts.tasks === readSheet_(SS.getSheetByName('Tasks'), TASK_COLUMNS).length);

console.log('\n== 10. 見出し行の不一致を検知 ==');
SS.getSheetByName('Projects').data[0][2] = 'ずれた見出し';
const broken = post({ token: TOKEN, dryRun: true, projects: payload.projects });
check('見出しずれでエラーを返す', broken.ok === false && /見出し行/.test(broken.error), broken.error);

console.log('\n== 11. testDryRunSample ==');
SS.getSheetByName('Projects').data[0][2] = 'name';
logs.length = 0;
testDryRunSample();
check('サンプル実行が成功', /"ok":true/.test(logs.join('')), logs.join('').slice(0, 200));

console.log('\n----------------------------------------');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
