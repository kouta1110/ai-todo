// 設定値をここに集約する。要件定義書10章「要決定事項」にあたる箇所は、
// 暫定値を置いたうえで後から変えられるようにしてある。各項目のコメントに
// 「要決定」と書いてあるものは、決まり次第ここを直す。

const APP_CONFIG = {
  // ---- Googleスプレッドシート接続 ----
  sheets: {
    // 正本にするスプレッドシートのID。
    // https://docs.google.com/spreadsheets/d/【ここがID】/edit
    // 接続先: Drive の「AI Todo タスク正本」
    // https://docs.google.com/spreadsheets/d/1g6Of2Ve2WaCeVkLt74IR1K3M-9z-w8jdQ9hiON4v2Rs/edit
    spreadsheetId: "1g6Of2Ve2WaCeVkLt74IR1K3M-9z-w8jdQ9hiON4v2Rs",

    // 小タスクを置くシート（タブ）の名前。ここに書いた名前のタブだけを読み書きし、
    // 同じスプレッドシート内の他のタブには触らない。
    tabName: "Tasks",

    // 大タスクを置くシート。読み取り専用で使う（分類・親子関係・進捗の表示用）。
    // アプリからは書き込まない。大タスクの正本はObsidianの `_概要.md`。
    projectsTabName: "Projects",

    // 上のタブが見つからないとき、先頭のタブで代用するか。
    //
    // [変更 2026-07-28] false に固定した。
    // 以前は true だったが、これが原因で事故が起きかけた。シートを
    // `tasks`（旧19列）から `Tasks`（新27列）へ移行した際、名前が一致しないため
    // 先頭タブへフォールバックし、列名が違うまま読み込んで `id` を見失い、
    // 行ごとにランダムなIDを発番したうえで全面上書きしようとした。
    // 想定と違うシートには、黙って書くより止まるほうが安全。
    fallbackToFirstTab: false,

    // 見出し行が何行目か（1始まり）。
    headerRow: 1,

    // 認証方式。要決定（要件定義書10章「アプリからスプレッドシートへ接続する実装方式」）。
    //   "none"    … 未接続。ブラウザ内の下書きだけで動く（MVP未達）
    //   "apiKey"  … 公開シートの読み取り専用。書き込みはできない
    //   "oauth"   … 読み書き可。MVPを満たすにはこれが必要
    authMode: "oauth",

    // authMode を "oauth" にするとき埋める。作り方は docs/Google接続手順.md を参照。
    //
    // clientId はブラウザに出る前提の識別子で、秘密情報ではない（クライアント
    // シークレットは使わない）。誰が使えるかは Google 側の
    // 「承認済みのJavaScript生成元」で制限するので、ここに書いてよい。
    // アクセストークンはメモリ上にだけ置き、保存はしない（要件7.3）。
    oauth: {
      clientId: "803532163784-cifk2t9kvm4n9vmlihsl3acgt78p07r3.apps.googleusercontent.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",

      // 一度同意したことを端末に覚えておき、2回目以降は同意画面を出さない。
      // 保存するのは「同意済み」の真偽値だけで、アクセストークンは保存しない
      // （トークンを保存すると、端末を他人に触られた間シートを読み書きされうる）。
      //
      // 「Googleに接続」を押す操作自体は残る。ブラウザがポップアップを塞ぐため、
      // 本人の操作なしにトークンを取りに行くことはできない。
      //
      // false にすると毎回フル同意画面に戻る。共用端末で使うときはそちら。
      rememberConsent: true,
      consentStorageKey: "aiTodo.googleConsented",

      // 認可に使うアカウントのメールアドレス。
      // prompt を空にしても飛ばせるのは権限確認までで、ブラウザに複数の
      // Googleアカウントがログインしていると選択画面が残る。ここが埋まっていると
      // そのアカウントで直接認可しにいくので、選択画面も出なくなる。
      //
      // リポジトリは公開なので、ここには書かない。初回の接続時にアプリが尋ね、
      // 入力された値はその端末の localStorage にだけ置く。端末ごとに1回入れる。
      // （どうしても全端末で共通にしたければ、ここに直接書いてもよい。
      //   秘密情報ではないが、公開リポジトリに載ることになる）
      accountHint: "",
      accountHintStorageKey: "aiTodo.googleAccountHint",
    },
    apiKey: "",
  },

  // ---- 列マッピング ----
  // 論理フィールド名 → スプレッドシートの見出し文字列。
  // 正本は `_AI/scripts/ai_todo_sync.gs` の TASK_COLUMNS / PROJECT_COLUMNS。
  // GAS側を直したらここも直す。
  columns: {
    id: "task_id",
    projectId: "project_id",
    title: "title",
    description: "description",
    status: "status",
    confirmation: "confirmation",
    priority: "priority",
    importance: "importance",
    urgency: "urgency",
    effort: "effort",
    deadline: "deadline",
    executor: "executor",
    autonomy: "autonomy",
    blockedBy: "blockedBy",
    nextAction: "nextAction",
    definitionOfDone: "definitionOfDone",
    sources: "sources",
    updated: "updated",
    aiExtracted: "aiExtracted",
    aiGenerated: "aiGenerated",
    aiEstimatedFields: "aiEstimatedFields",
    confirmedFields: "confirmedFields",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    completedAt: "completedAt",
    archivedAt: "archivedAt",
    version: "version",
  },

  // 大タスク（Projectsシート）の列。読み取り専用。
  projectColumns: {
    id: "project_id",
    parentId: "parent_project_id",
    name: "name",
    category: "category",
    activity: "activity",
    status: "status",
    phase: "phase",
    priority: "priority",
    progress: "progress",
    taskCount: "taskCount",
    nextAction: "nextAction",
    blockedBy: "blockedBy",
    autonomy: "autonomy",
    updated: "updated",
    source: "source",
    aiExtracted: "aiExtracted",
    aiEstimatedFields: "aiEstimatedFields",
    confirmedFields: "confirmedFields",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    version: "version",
  },

  // これが見出し行に無ければ、読み込みも保存も行わない。
  // 別スキーマのシートを掴んだまま書き込んで壊すのを防ぐ最後の砦。
  requiredColumns: ["id", "title", "status"],

  // 配列項目をセルにどう入れるか。要件6.1「JSON文字列または区切り文字列」。
  //   "json"      … ["a","b"] の形で入れる
  //   "delimited" … a|b の形で入れる（arrayDelimiter で区切り文字を指定）
  arrayEncoding: "json",
  arrayDelimiter: "|",

  // ---- 値の選択肢 ----
  priorities: [
    { key: "high", label: "高い" },
    { key: "medium", label: "普通" },
    { key: "low", label: "低い" },
  ],
  // タスクの重さ。旧 weight を Obsidian の effort に合わせて改名した。
  efforts: [
    { key: "light", label: "軽い" },
    { key: "medium", label: "普通" },
    { key: "heavy", label: "重い" },
  ],
  importances: [
    { key: "high", label: "高い" },
    { key: "medium", label: "普通" },
    { key: "low", label: "低い" },
  ],
  // 緊急度の段階は要決定（要件定義書10章）。暫定で3段階＋未設定にしてある。
  urgencies: [
    { key: "high", label: "すぐ" },
    { key: "medium", label: "近いうち" },
    { key: "low", label: "急がない" },
  ],
  // Obsidian の値をそのまま使う。todo/done へ変換しない（Obsidianが正本）。
  statuses: [
    { key: "未着手", label: "未着手" },
    { key: "進行中", label: "進行中" },
    { key: "保留", label: "保留" },
    { key: "完了", label: "完了" },
    { key: "キャンセル", label: "キャンセル" },
  ],
  // 未完了として一覧に出す状態。
  openStatuses: ["未着手", "進行中", "保留"],
  confirmations: [
    { key: "confirmed", label: "確定" },
    { key: "proposed", label: "AI提案" },
  ],
  executors: [
    { key: "本人", label: "本人" },
    { key: "AI", label: "AI" },
    { key: "共同", label: "共同" },
    { key: "外部", label: "外部" },
  ],

  // ---- 表示 ----
  display: {
    // 優先順位を文字サイズで表現する（要件4.4）。色だけに頼らないため、
    // 太さと行頭の印も併用する（要件7.1）。
    prioritySizeRem: { high: 1.5, medium: 1.15, low: 0.95 },
    priorityWeightCss: { high: 700, medium: 500, low: 400 },
    priorityMark: { high: "●", medium: "▪", low: "·" },

    // 期限なしタスクを一覧のどこに置くか。要決定（要件定義書10章）。
    //   "last" … 期限ありの後ろ  /  "first" … 先頭
    noDeadlinePosition: "last",

    // 期限まで何日以内を「近い」として補助ラベルを出すか。
    deadlineSoonDays: 3,

    // 既定の並び順。要件4.5「既定は期限の近い順」。
    defaultSort: "deadline",

    // 起動時のローダー（media/loader.mp4、1.35秒）。
    // 再生が終わったら消すが、自動再生が拒否される端末もあるので上限も持つ。
    splash: {
      enabled: true,
      // 一瞬で消えると点滅に見えるので、最低これだけは出す。
      minMs: 700,
      // 再生できないときの保険。これを過ぎたら中身に関わらず消す。
      maxMs: 4000,
      fadeMs: 320,
    },
  },

  // ---- 動作 ----
  behavior: {
    // 変更は自動保存せず「更新」ボタンでまとめて反映する（要件4.9）。
    autoSave: false,
    // 未保存のまま離脱しようとしたら警告する（要件4.9）。
    warnOnUnsavedExit: true,
    // 保存の競合検出に使うフィールド（要件4.9）。
    conflictField: "version",
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { APP_CONFIG };
}
