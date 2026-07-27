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

    // タスクを置くシート（タブ）の名前。ここに書いた名前のタブだけを読み書きし、
    // 同じスプレッドシート内の他のタブには触らない。
    tabName: "tasks",

    // 上のタブが見つからないとき、先頭のタブで代用するか。
    // CSVから作ったシートはタブ名がファイル名になることがあるため、既定で有効にしてある。
    // タブ名を厳密に固定したい場合は false にする。
    fallbackToFirstTab: true,

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
    },
    apiKey: "",
  },

  // ---- 列マッピング ----
  // 要件定義書6.1の論理フィールド名 → スプレッドシートの見出し文字列。
  // 実際の列名が決まったら右側だけを直す（要件定義書10章「実際の列構成」）。
  columns: {
    id: "id",
    title: "title",
    description: "description",
    priority: "priority",
    weight: "weight",
    deadline: "deadline",
    urgency: "urgency",
    status: "status",
    decisionStatus: "decisionStatus",
    sources: "sources",
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
  weights: [
    { key: "light", label: "軽い" },
    { key: "medium", label: "普通" },
    { key: "heavy", label: "重い" },
  ],
  // 緊急度の段階は要決定（要件定義書10章）。暫定で3段階＋未設定にしてある。
  urgencies: [
    { key: "high", label: "すぐ" },
    { key: "medium", label: "近いうち" },
    { key: "low", label: "急がない" },
  ],
  statuses: [
    { key: "todo", label: "未完了" },
    { key: "done", label: "完了" },
    { key: "archived", label: "アーカイブ" },
  ],
  decisionStatuses: [
    { key: "confirmed", label: "確定" },
    { key: "proposed", label: "AI提案" },
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
