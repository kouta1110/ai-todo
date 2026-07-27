# AI Todo

期限順にタスクを並べ、優先順位を**文字の大きさ**で伝える個人用のタスクアプリ。
データはGoogleスプレッドシートに置き、アプリはそれを読み書きするだけの静的サイト。

サーバー処理が無いので GitHub Pages で動く。スマホではホーム画面に追加してアプリとして使う。

## 画面

- **一覧** — 未完了の確定タスクを期限順に。期限切れ / 今日 / 明日 / 日付 / 期限なし で見出し分け
- **詳細・編集** — 1件の内容を直す。未保存のまま移動しようとすると警告が出る
- **完了・アーカイブ** — 片付いたものを別画面で見る

優先順位は文字サイズ・太さ・行頭の印の3つで表す。色は期限切れと緊急にだけ使い、
色が見えなくても情報が失われないようにしている。

AIが提案したタスクは一覧の下に別枠で置き、自分で確定したタスクと混ぜない。

## 構成

```
index.html      3画面ぶんのマークアップ
style.css
manifest.json   ホーム画面に追加するための設定
icons/
js/
  config.js     設定。決め打ちしたくない値はここに集約
  auth.js       Googleへの接続（トークン取得）
  model.js      タスクの構造、並び替え、絞り込み、AI更新の保護
  sheets.js     行⇄タスクの変換と接続アダプタ
  store.js      状態と未保存管理
  app.js        画面の組み立て
tests/
  logic.test.js 依存なしで動くロジックのテスト
  dom.smoke.js  画面の組み立て（要 jsdom）
  pwa.test.js   アイコン・manifest・公開前チェック
```

## 動かす

```bash
python3 -m http.server 8000
```

`http://localhost:8000` を開く。

`js/config.js` に自分のOAuthクライアントIDとスプレッドシートIDを入れ、
Google Cloud コンソールの「承認済みのJavaScript生成元」に
`http://localhost:8000` と公開先のドメインを登録しておく必要がある。

## テスト

```bash
node tests/logic.test.js
node tests/pwa.test.js
npm install jsdom && node tests/dom.smoke.js
```

## 注意

- アクセストークンは保存していないので、開くたびに「Googleに接続」を押す必要がある
- クライアントIDは公開前提の識別子。承認済みの生成元に登録したドメインからしか使えない
- スプレッドシートの中身はこのリポジトリには含まれない
