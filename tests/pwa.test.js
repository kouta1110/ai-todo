// ホーム画面に追加して使うための設定が揃っているかを確認する。
//   実行: node tests/pwa.test.js
//
// アイコンの欠落や manifest の書き間違いは、実機に入れるまで気づきにくいので
// ここで機械的に確認しておく。

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

// PNGの先頭から実際の縦横を読む（拡張子や設定を信用しない）
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.slice(1, 4).toString(), "PNG", `${file} がPNGではない`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---- manifest ----

test("manifest: 必要な項目が揃っている", () => {
  ["name", "short_name", "start_url", "scope", "display", "icons", "theme_color", "background_color"]
    .forEach((key) => assert.ok(manifest[key], `${key} が無い`));
});

test("manifest: ホーム画面から全画面で開く設定になっている", () => {
  assert.ok(["standalone", "fullscreen", "minimal-ui"].includes(manifest.display), manifest.display);
});

test("manifest: 相対パスなので、サブディレクトリ公開でも動く", () => {
  // GitHub Pages は https://ユーザー名.github.io/リポジトリ名/ の下に置かれる。
  // ここが絶対パス "/" だとルートを見に行って壊れる。
  assert.ok(manifest.start_url.startsWith("."), `start_url が相対でない: ${manifest.start_url}`);
  assert.ok(manifest.scope.startsWith("."), `scope が相対でない: ${manifest.scope}`);
  manifest.icons.forEach((i) => assert.ok(!i.src.startsWith("/"), `アイコンが絶対パス: ${i.src}`));
});

test("manifest: アイコンが実在し、宣言どおりの大きさである", () => {
  manifest.icons.forEach((icon) => {
    const file = path.join(root, icon.src);
    assert.ok(fs.existsSync(file), `${icon.src} が無い`);
    const [w, h] = icon.sizes.split("x").map(Number);
    const actual = pngSize(file);
    assert.strictEqual(actual.width, w, `${icon.src} の幅が違う`);
    assert.strictEqual(actual.height, h, `${icon.src} の高さが違う`);
  });
});

test("manifest: Androidのマスク表示用アイコンがある", () => {
  assert.ok(
    manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "purpose:maskable のアイコンが無いと、Androidで角が切れる"
  );
});

test("manifest: 512pxのアイコンがある（スプラッシュ表示に必要）", () => {
  assert.ok(manifest.icons.some((i) => i.sizes === "512x512"));
});

// ---- index.html ----

test("HTML: manifest を読み込んでいる", () => {
  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="manifest\.json"/);
});

test("HTML: iOSのホーム画面用アイコンを指定している", () => {
  const m = html.match(/<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/);
  assert.ok(m, "apple-touch-icon が無いと、iOSで白いアイコンになる");
  const file = path.join(root, m[1]);
  assert.ok(fs.existsSync(file), `${m[1]} が無い`);
  assert.strictEqual(pngSize(file).width, 180, "iOSは180pxを推奨");
});

test("HTML: ノッチ対応の viewport 指定がある", () => {
  assert.match(html, /viewport-fit=cover/);
});

test("HTML: theme-color が manifest と揃っている", () => {
  const m = html.match(/<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/);
  assert.ok(m, "theme-color が無い");
  assert.strictEqual(m[1], manifest.theme_color);
});

test("HTML: 参照しているファイルがすべて存在する", () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  refs.forEach((ref) => {
    assert.ok(fs.existsSync(path.join(root, ref)), `参照先が無い: ${ref}`);
  });
});

test("HTML: 絶対パス参照が無い（サブディレクトリ公開でも壊れない）", () => {
  const abs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(abs, [], `絶対パス参照: ${abs.join(", ")}`);
});

// ---- 安全面 ----

test("公開前チェック: クライアントシークレットらしき記述が無い", () => {
  const config = fs.readFileSync(path.join(root, "js/config.js"), "utf8");
  assert.ok(!/client_?secret/i.test(config), "クライアントシークレットは公開してはいけない");
  assert.ok(!/GOCSPX-/.test(config), "Googleのクライアントシークレットが書かれている");
});

test("公開前チェック: APIキーを空のままにしている", () => {
  const config = fs.readFileSync(path.join(root, "js/config.js"), "utf8");
  const m = config.match(/apiKey:\s*"([^"]*)"/);
  assert.ok(m, "apiKey の項目が無い");
  assert.strictEqual(m[1], "", "APIキーは制限なしで公開すると悪用されうる。OAuthを使う構成では空でよい");
});

test("公開前チェック: Web Appのtokenがリポジトリに混入していない", () => {
  // GitHub Pages で公開する前提なので、共有秘密が入っていたら即アウト。
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (["node_modules", ".git", "legacy"].includes(e.name)) return [];
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });

  const suspicious = [];
  walk(root)
    .filter((f) => /\.(js|json|html|css|md|sh|gs|csv|command)$/.test(f))
    .forEach((file) => {
      const text = fs.readFileSync(file, "utf8");
      // 実際に配られたtokenの接頭辞と、Apps Scriptの秘密になりうる形
      if (/aitodo_[A-Za-z0-9]{20,}/.test(text)) suspicious.push(`${path.relative(root, file)}: token`);
    });

  assert.deepStrictEqual(suspicious, [], `秘密情報が含まれています: ${suspicious.join(", ")}`);
});

test("公開前チェック: GASのTOKENが初期値のまま置かれている（原本の控えに実物を書かない）", () => {
  const gas = fs.readFileSync(path.join(root, "gas/ai_todo_sync.gs"), "utf8");
  const m = gas.match(/TOKEN:\s*"([^"]*)"/);
  assert.ok(m, "CFG.TOKEN が見つからない");
  assert.ok(m[1].startsWith("CHANGE_ME"), "控えのファイルには実際のtokenを書かない");
});

// ---- 起動時のローダー ----

test("ローダー: 動画と静止画が揃っている", () => {
  ["media/loader.mp4", "media/loader-still.webp"].forEach((f) => {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} が無い`);
  });
});

// 元は4.5MBのGIFだった。回線の細い端末では、ローダー自体の
// 読み込み待ちが起動を遅らせるので、軽いままかを機械的に見張る。
test("ローダー: 起動を遅らせない大きさに収まっている", () => {
  const total = ["media/loader.mp4", "media/loader-still.webp"]
    .reduce((sum, f) => sum + fs.statSync(path.join(root, f)).size, 0);
  assert.ok(total < 400 * 1024, `ローダーが重すぎる: ${Math.round(total / 1024)}KB`);
});

test("ローダー: 自動再生できる形で置いている", () => {
  const tag = html.match(/<video[^>]*id="splash-video"[^>]*>/);
  assert.ok(tag, "splash-video が無い");
  // iOSは muted と playsinline が無いとインライン自動再生を許さない
  ["muted", "playsinline", "autoplay"].forEach((attr) => {
    assert.ok(tag[0].includes(attr), `${attr} が要る（iOSで再生されない）`);
  });
});

test("ローダー: JSが動かなくても画面を塞ぎ続けない", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  assert.ok(/@keyframes\s+splash-failsafe/.test(css), "CSS側の保険が要る");
  assert.ok(/\.splash\s*\{[^}]*animation:\s*splash-failsafe/.test(css),
    ".splash に保険のアニメーションが当たっていない");
});

// ---- 公開範囲 ----
// 2026-07-27 決定: Pages を無料で使うためリポジトリは Public にする。
// アプリの動作に要らない個人的な内容（氏名入りのVaultパス、要件定義、作業メモ）は
// .gitignore で公開対象から外す。手元には残るが GitHub には上げない。

// GitHub に上げるファイル。ここに無いものは公開されない前提。
const PUBLISHED = ["index.html", "style.css", "manifest.json", "README.md"];
const PUBLISHED_DIRS = ["icons", "js", "tests", "media"];

// 公開対象に出てはいけない記述。
// アカウント名はホームディレクトリから取る。ここに直接書くと、
// このファイル自体が公開されるので本末転倒になる。
const account = path.basename(require("os").homedir());
const PRIVATE_PATTERNS = [
  [/\/Users\/[a-z]/i, "Macのホームパス"],
  [new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "アカウント名"],
  [/Mobile Documents/, "Vaultのパス"],
];

test("公開範囲: 公開するファイルに氏名やホームパスが混入していない", () => {
  const files = [
    ...PUBLISHED.map((f) => path.join(root, f)),
    ...PUBLISHED_DIRS.flatMap((d) =>
      fs.readdirSync(path.join(root, d)).map((f) => path.join(root, d, f))
    ),
  ]
    // このファイルは判定に使う語そのものを持っているので対象外にする
    .filter((f) => f !== __filename)
    .filter((f) => fs.statSync(f).isFile() && /\.(js|json|html|css|md)$/.test(f));

  const found = [];
  files.forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    PRIVATE_PATTERNS.forEach(([re, label]) => {
      if (re.test(text)) found.push(`${path.relative(root, file)}: ${label}`);
    });
  });
  assert.deepStrictEqual(found, [], `公開対象に個人情報が入っています: ${found.join(", ")}`);
});

test("公開範囲: 非公開にすると決めたものが .gitignore に入っている", () => {
  const ignore = fs
    .readFileSync(path.join(root, ".gitignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  ["NOTES.md", "TODO.md", "RESUME.md", "REQUIREMENTS.md", "gas/", "docs/", "legacy/",
    "start.command", "公開する.command"]
    .forEach((entry) => {
      assert.ok(ignore.includes(entry), `.gitignore に ${entry} が無い`);
    });
});

test("公開範囲: アプリの動作に要るファイルを誤って除外していない", () => {
  const ignore = fs
    .readFileSync(path.join(root, ".gitignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  [...PUBLISHED, ...PUBLISHED_DIRS.map((d) => `${d}/`)].forEach((entry) => {
    assert.ok(!ignore.includes(entry), `${entry} は公開しないと動かない`);
  });
});

// ---- 結果 ----

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
