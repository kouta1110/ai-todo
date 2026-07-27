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

  // 同意画面（ポップアップ）を開く。ブラウザに塞がれるため、
  // 必ずボタンのクリックなど本人の操作から呼ぶこと。
  async connect(config = APP_CONFIG) {
    const client = await this.ensureClient(config);
    const firstTime = !this.token;
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
      // 2回目以降は同意済みなので確認画面を出さない。
      client.requestAccessToken({ prompt: firstTime ? "consent" : "" });
    });
  },

  // 読み書きの直前に呼ばれる。ここではポップアップを開かず、
  // 有効なトークンが無ければ「接続してください」と伝えるだけにする。
  async getToken() {
    if (isTokenValid(this.token)) return this.token.value;
    this.token = null;
    throw new Error("Googleに接続してください（上部の「Googleに接続」ボタン）");
  },

  disconnect() {
    const value = this.token && this.token.value;
    this.token = null;
    if (value && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(value, () => {});
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
