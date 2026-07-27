// Googleスプレッドシートを読み書きするためのアクセストークン取得。
// Google Identity Services（GIS）のトークンモデルを使う。
//
// 要件7.3「認証情報をフロントエンドへ直接埋め込まない」について:
//   ここで扱うのはクライアントIDだけで、クライアントシークレットは使わない。
//   クライアントIDは公開前提の識別子で、秘密情報ではない（誰が使えるかは
//   Google側の「承認済みのJavaScript生成元」で制限する）。
//   アクセストークンはメモリ上にだけ置き、localStorageには保存しない。
//   更新トークンも受け取らないので、期限が切れたら本人の操作で取り直す。

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

// 期限の60秒手前で切れたものとして扱う（通信中に失効するのを避けるため）。
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

function isTokenValid(token, now = Date.now()) {
  return Boolean(token && token.value && token.expiresAt > now);
}

function storage() {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

// localStorage は Safari のプライベートブラウズなどで例外を投げることがある。
// 覚えられなくても動作は続けられるので、失敗は握りつぶして既定の挙動に戻す。
function readFlag(key) {
  try {
    const s = storage();
    return Boolean(s) && s.getItem(key) === "1";
  } catch (err) {
    return false;
  }
}

function writeFlag(key, value) {
  try {
    const s = storage();
    if (!s) return;
    if (value) s.setItem(key, "1");
    else s.removeItem(key);
  } catch (err) {
    /* 覚えられないだけなので続行する */
  }
}

const GoogleAuth = {
  token: null,
  tokenClient: null,
  scriptPromise: null,

  isConfigured(config = APP_CONFIG) {
    return Boolean(config.sheets.oauth && config.sheets.oauth.clientId);
  },

  isSignedIn() {
    return isTokenValid(this.token);
  },

  loadScript() {
    if (this.scriptPromise) return this.scriptPromise;
    this.scriptPromise = new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = GIS_SCRIPT_URL;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Googleの認証ライブラリを読み込めませんでした"));
      document.head.appendChild(script);
    });
    return this.scriptPromise;
  },

  async ensureClient(config = APP_CONFIG) {
    if (this.tokenClient) return this.tokenClient;
    if (!this.isConfigured(config)) {
      throw new Error("クライアントIDが未設定です（js/config.js の sheets.oauth.clientId）");
    }
    await this.loadScript();
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: config.sheets.oauth.clientId,
      scope: config.sheets.oauth.scope,
      callback: () => {}, // 実際の受け取りは connect() で差し替える
    });
    return this.tokenClient;
  },

  // 以前に同意を済ませているか。メモリ上のトークンはリロードで消えるので、
  // それだけを見ると毎回「初回」扱いになり、フル同意画面が出てしまう。
  hasConsented(config = APP_CONFIG) {
    const o = config.sheets.oauth || {};
    if (!o.rememberConsent || !o.consentStorageKey) return false;
    return readFlag(o.consentStorageKey);
  },

  rememberConsent(config = APP_CONFIG, value = true) {
    const o = config.sheets.oauth || {};
    if (!o.rememberConsent || !o.consentStorageKey) return;
    writeFlag(o.consentStorageKey, value);
  },

  // 同意画面（ポップアップ）を開く。ブラウザに塞がれるため、
  // 必ずボタンのクリックなど本人の操作から呼ぶこと。
  //
  // 同意済みなら prompt を空にして、アカウント選択と権限確認を飛ばす。
  // 取り消されていた場合はここで弾かれるので、覚えを捨ててもう一度押してもらう
  // （失敗のあと自動でやり直すと、本人の操作から離れてポップアップが塞がれる）。
  async connect(config = APP_CONFIG) {
    const client = await this.ensureClient(config);
    const skipConsent = !this.token && this.hasConsented(config);
    const silent = Boolean(this.token) || skipConsent;

    try {
      const value = await this.requestToken(client, silent ? "" : "consent");
      this.rememberConsent(config, true);
      return value;
    } catch (err) {
      if (skipConsent) {
        this.rememberConsent(config, false);
        throw new Error("Googleの許可が切れていました。もう一度「Googleに接続」を押してください");
      }
      throw err;
    }
  },

  requestToken(client, prompt) {
    return new Promise((resolve, reject) => {
      client.callback = (response) => {
        if (response.error) {
          reject(new Error(`Googleへの接続に失敗しました（${response.error}）`));
          return;
        }
        this.token = {
          value: response.access_token,
          expiresAt: Date.now() + Number(response.expires_in) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
        };
        resolve(this.token.value);
      };
      client.error_callback = (err) => {
        reject(new Error(`Googleへの接続に失敗しました（${err && err.type ? err.type : "不明"}）`));
      };
      client.requestAccessToken({ prompt: prompt });
    });
  },

  // 読み書きの直前に呼ばれる。ここではポップアップを開かず、
  // 有効なトークンが無ければ「接続してください」と伝えるだけにする。
  async getToken() {
    if (isTokenValid(this.token)) return this.token.value;
    this.token = null;
    throw new Error("Googleに接続してください（上部の「Googleに接続」ボタン）");
  },

  // 本人が明示的に切るので、許可そのものを取り消して覚えも捨てる。
  // 次に接続するときは同意画面から始まる。
  disconnect(config = APP_CONFIG) {
    const value = this.token && this.token.value;
    this.token = null;
    this.rememberConsent(config, false);
    const g = typeof window !== "undefined" ? window.google : null;
    if (value && g && g.accounts && g.accounts.oauth2) {
      g.accounts.oauth2.revoke(value, () => {});
    }
  },
};

// js/sheets.js の GoogleSheetsProvider はこの関数を探して呼ぶ。
if (typeof window !== "undefined") {
  window.getSheetsAccessToken = () => GoogleAuth.getToken();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { GoogleAuth, isTokenValid, TOKEN_EXPIRY_MARGIN_MS };
}
