// 画面の組み立てとイベント。状態は js/store.js、判断の規則は js/model.js にある。
// 対応する要件: 5章 画面要件 / 4.4〜4.9

let currentView = "list";
let editingId = null;
const filters = {};

// 一覧のまとめ方。"deadline" は期限順（従来）、"folder" は分類フォルダ順。
let groupMode = "deadline";

// ---- 小さな道具 ----

const $ = (sel) => document.querySelector(sel);
const labelOf = (list, key) => (list.find((x) => x.key === key) || {}).label || "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDeadline(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return time === "00:00" ? null : time;
}

function toInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function showNotice(text) {
  const node = $("#notice");
  if (!text) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }
  node.textContent = text;
  node.classList.remove("hidden");
}

// ---- 画面切替 ----

const TITLES = { list: "今やること", detail: "タスクの詳細", archive: "完了・アーカイブ" };

function showView(name) {
  currentView = name;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $("#page-title").textContent = TITLES[name];
  $("#btn-back").classList.toggle("hidden", name === "list");
  $("#btn-add").classList.toggle("hidden", name !== "list");
  render();
}

// ---- 同期状態（要件5.4） ----

function renderSyncState() {
  const node = $("#sync-state");
  const state = store.syncState;
  let text = SYNC_STATES[state] || "";
  if (state === "saved" && store.lastSavedAt) {
    text = `更新済み ${store.lastSavedAt.getHours()}:${String(store.lastSavedAt.getMinutes()).padStart(2, "0")}`;
  }
  if (state === "loaded" && store.lastLoadedAt) {
    text = `読み込み済み ${store.lastLoadedAt.getHours()}:${String(store.lastLoadedAt.getMinutes()).padStart(2, "0")}`;
  }
  node.textContent = text;
  node.dataset.state = state;

  const btn = $("#btn-sync");
  btn.disabled = state === "saving" || state === "loading";
  btn.textContent = state === "error" ? "再試行" : store.syncState === "dirty" ? "更新（未保存）" : "更新";

  renderAuthButtons();

  const messages = [];
  if (store.message) messages.push(store.message);
  if (store.warnings.length > 0) messages.push(...store.warnings);
  if (!store.provider.isWritable()) messages.push("読み取り専用の接続です。変更はスプレッドシートへ反映されません。");
  if (store.provider.key === "local") {
    messages.push("スプレッドシート未接続です。いまの変更はこのブラウザの中にだけ残ります。");
  }
  if (needsConnection()) {
    messages.push("Googleに接続するとスプレッドシートを読み書きします。");
  }
  showNotice(messages.join(" / "));
}

// ---- 起動時のローダー ----

function dismissSplash(splash, fadeMs) {
  if (!splash || splash.dataset.leaving === "1") return;
  splash.dataset.leaving = "1";
  splash.classList.add("is-leaving");
  window.setTimeout(() => splash.remove(), fadeMs + 60);
}

// 再生が終わったら消す。自動再生を拒否する端末や、動画を再生できない環境も
// あるので、失敗したときと上限時間の両方で必ず消えるようにしておく。
function setupSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;

  const cfg = (APP_CONFIG.display && APP_CONFIG.display.splash) || {};
  if (cfg.enabled === false) {
    splash.remove();
    return;
  }
  // 0 を「指定なし」と取り違えないよう、null/undefined のときだけ既定値にする。
  const ms = (value, fallback) => (value == null ? fallback : Number(value));
  const fadeMs = ms(cfg.fadeMs, 320);
  const minMs = ms(cfg.minMs, 0);
  const maxMs = ms(cfg.maxMs, 4000);
  splash.style.setProperty("--splash-fade", `${fadeMs}ms`);

  const startedAt = Date.now();
  const finish = () => {
    const rest = Math.max(0, minMs - (Date.now() - startedAt));
    window.setTimeout(() => dismissSplash(splash, fadeMs), rest);
  };

  window.setTimeout(() => dismissSplash(splash, fadeMs), maxMs);

  const reduced = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const video = document.getElementById("splash-video");
  if (reduced || !video) {
    finish();
    return;
  }

  video.addEventListener("ended", finish);
  video.addEventListener("error", finish);
  try {
    const playing = video.play();
    if (playing && playing.catch) playing.catch(finish);
  } catch (err) {
    finish(); // 再生できない環境（テスト用のDOMなど）
  }
}

// OAuth接続が必要な状態か（設定が oauth なのに、まだトークンが無い）。
function needsConnection() {
  return store.provider.key === "oauth" && !GoogleAuth.isSignedIn();
}

function renderAuthButtons() {
  const isOauth = store.provider.key === "oauth";
  $("#btn-connect").classList.toggle("hidden", !needsConnection());
  $("#btn-disconnect").classList.toggle("hidden", !(isOauth && GoogleAuth.isSignedIn()));

  // アカウントを覚えていない間だけ入力欄を出す。一度入れたら引っ込む。
  const setup = $("#account-setup");
  if (setup) {
    const needsHint = needsConnection() && !GoogleAuth.getAccountHint(APP_CONFIG);
    setup.classList.toggle("hidden", !needsHint);
  }
}

// 保存しただけで接続はしない。ここで続けて接続へ行くと、本人の操作から
// 離れたとみなされてポップアップが塞がれることがある。
function handleSaveAccountHint() {
  const input = $("#account-hint");
  const value = GoogleAuth.setAccountHint(APP_CONFIG, input.value);
  input.value = "";
  setSync("idle", value
    ? `${value} を覚えました。「Googleに接続」を押してください`
    : "アカウントの指定を消しました");
  render();
}

async function handleConnect() {
  const btn = $("#btn-connect");
  btn.disabled = true;
  try {
    await GoogleAuth.connect(APP_CONFIG);
    await load();
  } catch (err) {
    setSync("error", err.message);
  } finally {
    btn.disabled = false;
    render();
  }
}

// 覚えたアカウントもここで捨てる。別のアカウントに切り替える手段がこれしかない。
function handleDisconnect() {
  GoogleAuth.disconnect(APP_CONFIG);
  GoogleAuth.setAccountHint(APP_CONFIG, "");
  setSync("idle", "Googleとの接続を切りました（アカウントの指定も消しました）");
  render();
}

// ---- 一覧（要件5.1） ----

function buildTaskRow(task, options = {}) {
  const row = el("button", "task");
  row.type = "button";
  row.dataset.id = task.id;
  row.dataset.priority = task.priority;

  const sizes = APP_CONFIG.display.prioritySizeRem;
  const weights = APP_CONFIG.display.priorityWeightCss;
  const marks = APP_CONFIG.display.priorityMark;

  row.appendChild(el("span", "task-mark", marks[task.priority] || ""));

  const title = el("h3", "task-title", task.title);
  title.style.setProperty("--title-size", `${sizes[task.priority] || 1.15}rem`);
  title.style.setProperty("--title-weight", weights[task.priority] || 500);
  row.appendChild(title);

  if (options.action) {
    const action = el("button", "task-check", options.action.label);
    action.type = "button";
    action.addEventListener("click", (e) => {
      e.stopPropagation();
      options.action.onClick(task);
    });
    row.appendChild(action);
  } else {
    row.appendChild(el("span"));
  }

  const meta = el("div", "task-meta");
  const time = formatDeadline(task.deadline);
  if (time) meta.appendChild(el("span", "tag", `${time}まで`));
  meta.appendChild(el("span", "tag", `優先 ${labelOf(APP_CONFIG.priorities, task.priority)}`));
  meta.appendChild(el("span", "tag", `重さ ${labelOf(APP_CONFIG.efforts, task.effort)}`));
  if (task.status !== "未着手") meta.appendChild(el("span", "tag", task.status));
  if (task.urgency === "high" || isOverdue(task)) {
    meta.appendChild(el("span", "tag urgent", isOverdue(task) ? "期限切れ" : "すぐ"));
  } else if (task.urgency) {
    meta.appendChild(el("span", "tag", labelOf(APP_CONFIG.urgencies, task.urgency)));
  }
  if (hasUnconfirmedAi(task)) meta.appendChild(el("span", "tag ai", "AI未確認"));
  row.appendChild(meta);

  row.addEventListener("click", () => openDetail(task.id));
  return row;
}

function renderList() {
  const container = $("#task-list");
  container.innerHTML = "";

  const active = filterTasks(store.tasks, { ...filters, open: true, confirmation: "confirmed" });
  const sorted = sortTasks(active, { noDeadlinePosition: APP_CONFIG.display.noDeadlinePosition });

  if (sorted.length === 0) {
    container.appendChild(
      el("p", "empty", store.tasks.length === 0 ? "タスクがありません。" : "この条件に合うタスクはありません。")
    );
  } else if (groupMode === "folder") {
    renderFolderGroups(container, sorted);
  } else {
    renderDeadlineGroups(container, sorted);
  }

  // AI提案は別枠（要件4.3）
  const proposals = filterTasks(store.tasks, { open: true, confirmation: "proposed" });
  const box = $("#proposals");
  const list = $("#proposal-list");
  list.innerHTML = "";
  box.classList.toggle("hidden", proposals.length === 0);
  sortTasks(proposals, { noDeadlinePosition: APP_CONFIG.display.noDeadlinePosition }).forEach((task) =>
    list.appendChild(
      buildTaskRow(task, { action: { label: "採用", onClick: (t) => acceptProposal(t.id) } })
    )
  );
}

// 期限順（従来の表示）
function renderDeadlineGroups(container, sorted) {
  groupByDeadline(sorted).forEach((group) => {
    const section = el("section", "date-group");
    section.dataset.kind = group.key === "overdue" ? "overdue" : group.key === "none" ? "none" : "date";
    const head = el("div", "date-head");
    head.appendChild(el("h2", null, group.label));
    head.appendChild(el("span", "count", `${group.tasks.length}件`));
    section.appendChild(head);
    group.tasks.forEach((task) =>
      section.appendChild(
        buildTaskRow(task, { action: { label: "完了", onClick: (t) => changeStatus(t.id, "done") } })
      )
    );
    container.appendChild(section);
  });
}

// 開閉状態は端末に覚えておく。畳んだ場所が毎回開き直ると、
// 分類の多い人ほど毎回同じ操作を繰り返すことになる。
const DISCLOSURE_KEY = "aiTodo.openGroups";

function loadDisclosure() {
  try {
    const raw = localStorage.getItem(DISCLOSURE_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveDisclosure(open) {
  try {
    localStorage.setItem(DISCLOSURE_KEY, JSON.stringify([...open]));
  } catch {
    // 保存できなくても表示は続ける（プライベートモードなど）
  }
}

let openGroups = null;

// 既定は「分類フォルダは開く・大タスクは畳む」。
// 全部開くと一覧が長くなりすぎ、全部畳むと毎回2回開く必要がある。
function defaultOpen(folders) {
  return new Set(folders.map((f) => `folder:${f.key}`));
}

function isOpenGroup(key) {
  return openGroups.has(key);
}

function toggleGroup(key, open) {
  if (open) openGroups.add(key);
  else openGroups.delete(key);
  saveDisclosure(openGroups);
}

// 開閉できる見出しを作る。<details>/<summary> は素で開閉と
// キーボード操作を持っているので、自前で状態を持たない。
function disclosure(key, className, buildSummary, buildBody) {
  const box = el("details", className);
  box.open = isOpenGroup(key);
  const head = el("summary");
  buildSummary(head);
  box.appendChild(head);

  const body = el("div", "disclosure-body");
  buildBody(body);
  box.appendChild(body);

  box.addEventListener("toggle", () => toggleGroup(key, box.open));
  return box;
}

// 分類フォルダ → 大タスク → 小タスク の3階層。
// Obsidianのフォルダ構造をそのまま辿れるようにして、どの活動の話かを見失わないようにする。
function renderFolderGroups(container, sorted) {
  const folders = buildFolderTree(sorted, store.projects);

  if (folders.length === 0) {
    container.appendChild(el("p", "empty", "表示できる分類がありません。"));
    return;
  }

  if (openGroups === null) openGroups = loadDisclosure() || defaultOpen(folders);

  folders.forEach((folder) => {
    const section = disclosure(
      `folder:${folder.key}`,
      "folder-group",
      (head) => {
        head.appendChild(el("span", "caret"));
        head.appendChild(el("h2", null, folder.label));
        head.appendChild(el("span", "count", `${folder.openCount}件`));
      },
      (body) => {
        folder.projects.forEach((group) => {
          const key = `project:${group.project.id}`;
          const progress = group.project.progress;
          const pct = progress != null && !Number.isNaN(progress) ? Math.round(progress * 100) : null;

          body.appendChild(
            disclosure(
              key,
              "project-group",
              (head) => {
                head.appendChild(el("span", "caret"));

                const label = el("span", "project-label");
                // 中間フォルダ（AIToDoアプリ など）はパンくずで出す
                if (group.path.length > 0) {
                  label.appendChild(el("span", "project-path", group.path.join(" / ")));
                }
                label.appendChild(el("h3", null, group.project.name || group.project.id));
                head.appendChild(label);

                // 畳んだままでも状況が分かるように、件数と進捗は見出しに出す
                head.appendChild(el("span", "count", `${group.tasks.length}件`));
                if (pct != null) {
                  const bar = el("div", "progress");
                  bar.setAttribute("role", "img");
                  bar.setAttribute("aria-label", `進捗 ${pct}パーセント`);
                  const fill = el("div", "progress-fill");
                  fill.style.width = `${pct}%`;
                  bar.appendChild(fill);
                  head.appendChild(bar);
                  head.appendChild(el("span", "count pct", `${pct}%`));
                }
                if (group.project.status) head.appendChild(el("span", "tag", group.project.status));
              },
              (body2) => {
                if (group.project.nextAction) {
                  body2.appendChild(el("p", "project-next", `次の一手: ${group.project.nextAction}`));
                }
                group.tasks.forEach((task) =>
                  body2.appendChild(
                    buildTaskRow(task, { action: { label: "完了", onClick: (t) => changeStatus(t.id, "done") } })
                  )
                );
              }
            )
          );
        });
      }
    );
    section.dataset.folder = folder.key;
    container.appendChild(section);
  });
}

function renderArchive() {
  const done = store.tasks
    .filter((t) => isDone(t))
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  const archived = store.tasks
    .filter((t) => isArchived(t) && !isDone(t))
    .sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0));

  const fill = (node, tasks, emptyText) => {
    node.innerHTML = "";
    if (tasks.length === 0) {
      node.appendChild(el("p", "empty", emptyText));
      return;
    }
    tasks.forEach((task) =>
      node.appendChild(
        buildTaskRow(task, { action: { label: "戻す", onClick: (t) => changeStatus(t.id, "todo") } })
      )
    );
  };
  fill($("#done-list"), done, "完了したタスクはまだありません。");
  fill($("#archived-list"), archived, "アーカイブしたタスクはありません。");
}

// ---- 詳細・編集（要件5.2） ----

function fillSelect(node, options, includeEmpty = false) {
  node.innerHTML = "";
  if (includeEmpty) node.appendChild(new Option("未設定", ""));
  options.forEach((o) => node.appendChild(new Option(o.label, o.key)));
}

function openDetail(id) {
  editingId = id;
  const task = id ? getTask(id) : null;

  $("#f-title").value = task ? task.title : "";
  $("#f-description").value = task ? task.description : "";
  $("#f-priority").value = task ? task.priority : "medium";
  // DOM上のidは #f-weight のまま（画面の見出しは「重さ」）。
  // データ側の項目名だけ Obsidian に合わせて effort へ変えてある。
  $("#f-weight").value = task ? task.effort : "medium";
  $("#f-deadline").value = task ? toInputValue(task.deadline) : "";
  $("#f-urgency").value = task && task.urgency ? task.urgency : "";
  $("#form-errors").classList.add("hidden");

  $("#btn-complete").classList.toggle("hidden", !task || !isOpen(task));
  $("#btn-archive").classList.toggle("hidden", !task || isArchived(task));
  $("#btn-reopen").classList.toggle("hidden", !task || isOpen(task));

  renderAiInfo(task);
  renderSourceInfo(task);
  showView("detail");
}

// AIが判断した項目を確認できるようにする（要件5.2 / 4.6）
function renderAiInfo(task) {
  const node = $("#ai-info");
  if (!task || (!task.aiExtracted && !task.aiGenerated && task.aiEstimatedFields.length === 0)) {
    node.classList.add("hidden");
    node.innerHTML = "";
    return;
  }
  node.classList.remove("hidden");
  node.innerHTML = "";
  const kinds = [];
  if (task.aiExtracted) kinds.push("Obsidianから抽出");
  if (task.aiGenerated) kinds.push("AIが新しく提案");
  node.appendChild(el("strong", null, `AIの関与: ${kinds.join(" / ") || "なし"}`));

  const dl = el("dl");
  if (task.aiEstimatedFields.length > 0) {
    dl.appendChild(el("dt", null, "AIが推定した項目"));
    const unconfirmed = task.aiEstimatedFields.filter((f) => !task.confirmedFields.includes(f));
    dl.appendChild(
      el("dd", null, `${task.aiEstimatedFields.join(", ")}${unconfirmed.length ? `（未確認: ${unconfirmed.join(", ")}）` : "（確認済み）"}`)
    );
  }
  if (task.confirmedFields.length > 0) {
    dl.appendChild(el("dt", null, "本人が確定した項目（AI更新で上書きされない）"));
    dl.appendChild(el("dd", null, task.confirmedFields.join(", ")));
  }
  if (task.pendingProposal) {
    dl.appendChild(el("dt", null, "AIからの変更候補（未反映）"));
    dl.appendChild(el("dd", null, JSON.stringify(task.pendingProposal)));
  }
  node.appendChild(dl);
}

function renderSourceInfo(task) {
  const node = $("#source-info");
  if (!task) {
    node.textContent = "新しいタスクは「本人による直接入力」として記録されます。";
    return;
  }
  node.textContent = `出典: ${task.sources.length ? task.sources.join(" / ") : "不明"}`;
}

// ---- 操作 ----

function saveForm(e) {
  e.preventDefault();
  const deadlineRaw = $("#f-deadline").value;
  const changes = {
    title: $("#f-title").value.trim(),
    description: $("#f-description").value.trim(),
    priority: $("#f-priority").value,
    effort: $("#f-weight").value,
    deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
    urgency: $("#f-urgency").value || null,
  };

  const result = editingId ? editTask(editingId, changes) : addTask(changes);
  if (!result.ok) {
    const node = $("#form-errors");
    node.textContent = result.errors.join(" / ");
    node.classList.remove("hidden");
    return;
  }
  showView("list");
}

function changeStatus(id, action) {
  setStatus(id, action);
  if (currentView === "detail") showView("list");
  else render();
}

function acceptProposal(id) {
  confirmProposal(id);
  render();
}

async function handleSync() {
  // 未保存があれば保存、無ければ最新を取り直す（要件4.9）。
  if (isDirty() || store.syncState === "error") {
    const result = await save();
    if (result.ok) showNotice("");
    return;
  }
  await load();
}

// ---- 起動 ----

function setupFilters() {
  const build = (node, options, key) => {
    node.innerHTML = "";
    options.forEach((o) => {
      const btn = el("button", "filter", o.label);
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        filters[key] = filters[key] === o.key ? undefined : o.key;
        syncFilterButtons();
        render();
      });
      btn.dataset.key = key;
      btn.dataset.value = o.key;
      node.appendChild(btn);
    });
  };
  build($("#filter-priority"), APP_CONFIG.priorities, "priority");
  build($("#filter-weight"), APP_CONFIG.efforts, "effort");

  // 期限順 / フォルダ順の切り替え
  const toggle = $("#btn-group-mode");
  if (toggle) {
    const sync = () => {
      toggle.textContent = groupMode === "folder" ? "フォルダ順" : "期限順";
      toggle.setAttribute("aria-pressed", String(groupMode === "folder"));
    };
    toggle.addEventListener("click", () => {
      groupMode = groupMode === "folder" ? "deadline" : "folder";
      sync();
      render();
    });
    sync();
  }

  document.querySelectorAll("[data-flag]").forEach((btn) => {
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      const flag = btn.dataset.flag;
      filters[flag] = filters[flag] ? undefined : true;
      syncFilterButtons();
      render();
    });
  });

  $("#btn-clear-filters").addEventListener("click", () => {
    Object.keys(filters).forEach((k) => delete filters[k]);
    syncFilterButtons();
    render();
  });
}

function syncFilterButtons() {
  document.querySelectorAll(".filter[data-key]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(filters[btn.dataset.key] === btn.dataset.value));
  });
  document.querySelectorAll("[data-flag]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(Boolean(filters[btn.dataset.flag])));
  });
}

function render() {
  renderSyncState();
  if (currentView === "list") renderList();
  else if (currentView === "archive") renderArchive();
}

function initApp() {
  setupSplash();
  fillSelect($("#f-priority"), APP_CONFIG.priorities);
  fillSelect($("#f-weight"), APP_CONFIG.efforts);
  fillSelect($("#f-urgency"), APP_CONFIG.urgencies, true);
  setupFilters();

  $("#btn-add").addEventListener("click", () => openDetail(null));
  $("#btn-back").addEventListener("click", () => showView("list"));
  $("#btn-cancel").addEventListener("click", () => showView("list"));
  $("#btn-open-archive").addEventListener("click", () => showView("archive"));
  $("#task-form").addEventListener("submit", saveForm);
  $("#btn-complete").addEventListener("click", () => changeStatus(editingId, "done"));
  $("#btn-archive").addEventListener("click", () => changeStatus(editingId, "archived"));
  $("#btn-reopen").addEventListener("click", () => changeStatus(editingId, "todo"));
  $("#btn-sync").addEventListener("click", handleSync);
  $("#btn-connect").addEventListener("click", handleConnect);
  $("#btn-disconnect").addEventListener("click", handleDisconnect);
  $("#btn-save-hint").addEventListener("click", handleSaveAccountHint);
  $("#account-hint").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleSaveAccountHint(); }
  });

  // 未保存のまま離脱しようとしたら警告する（要件4.9 / 受け入れ条件14）
  if (APP_CONFIG.behavior.warnOnUnsavedExit) {
    window.addEventListener("beforeunload", (e) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "保存されていません";
      return "保存されていません";
    });
  }

  subscribe(render);
  init(selectProvider(APP_CONFIG));

  // OAuth接続が必要なときは、いきなり読み込みに行かない。
  // ポップアップは本人の操作からしか開けないので、「Googleに接続」を押してもらう。
  if (needsConnection()) {
    if (!GoogleAuth.isConfigured(APP_CONFIG)) {
      setSync("error", "クライアントIDが未設定です（js/config.js の sheets.oauth.clientId）");
    } else {
      setSync("idle");
    }
    render();
    return;
  }
  load();
}

// テストから読めるよう、起動処理だけ関数にしてある。
if (typeof document !== "undefined" && document.getElementById("view-list")) {
  initApp();
}
