/**
 * 雪妖精の辭書 — Firebase 選配雲端同步設定檔
 * ------------------------------------------------------------
 * 1. 前往 Firebase Console 建立專案 → 啟用 Authentication (Google 登入) 與 Cloud Firestore。
 * 2. 將專案的 firebaseConfig 貼入下方 window.YUKIYOSEI_FIREBASE_CONFIG 即可自動啟用跨裝置同步。
 * 3. 若未填寫（apiKey 為空），App 會自動維持純本機 Local-First 單機模式運作。
 */
window.YUKIYOSEI_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
