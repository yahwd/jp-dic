    let dictData = [];
    let zhBridge = {};
    let isDbReady = false;

    // ===== Local-First 雙向合併同步與多帳號防呆（Firebase Auth + Firestore Ready）=====
    const STORAGE_KEYS = {
      favs: 'private_jp_favs',
      hist: 'private_jp_hist',
      studyLog: 'yukiyosei_study_log_v1',
      wrongBank: 'yukiyosei_wrong_bank_v1',
      dailyQuiz: 'yukiyosei_daily_quiz_v1',
      quizCarryover: 'yukiyosei_quiz_carryover_v1',
      lastSyncedUid: 'lastSyncedUid'
    };

    // 數量上限：超過上限自動從最舊的開始移除（兼顧效能與 Firestore 文件大小）
    const COLLECTION_LIMITS = {
      history: 200,
      favorites: 50,
      wrongBank: 200
    };

    function safeReadJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    }

    function safeWriteJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {}
    }

    function entryIdFromTuple(entry) {
      if (!Array.isArray(entry)) return '';
      const main = (entry[0] && entry[0][0]) || (entry[1] && entry[1][0]) || '';
      const reading = (entry[1] && entry[1][0]) || '';
      return `${main}__${reading}`;
    }

    // 1. 收藏清單（支援軟刪除 deleted: true 與 updatedAt，避免跨裝置同步幽靈復活）
    function loadFavoritesStore() {
      const now = Date.now();
      const raw = safeReadJson(STORAGE_KEYS.favs, null);
      if (Array.isArray(raw)) {
        const items = raw
          .filter(e => Array.isArray(e))
          .map(entry => ({ id: entryIdFromTuple(entry), entry, updatedAt: now, deleted: false }));
        const migrated = { version: 2, updatedAt: now, items };
        safeWriteJson(STORAGE_KEYS.favs, migrated);
        return migrated;
      }
      if (raw && Array.isArray(raw.items)) {
        return {
          version: 2,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
          items: raw.items.filter(it => it && it.id)
        };
      }
      return { version: 2, updatedAt: 0, items: [] };
    }

    // 2. 搜尋歷史清單（附帶 updatedAt 與軟刪除 clearedAt，支援跨裝置同步）
    function loadHistoryStore() {
      const now = Date.now();
      const raw = safeReadJson(STORAGE_KEYS.hist, null);
      if (Array.isArray(raw)) {
        const items = raw
          .filter(it => it && it.q)
          .map((it, idx) => ({
            q: String(it.q),
            time: String(it.time || ''),
            updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : (now - idx)
          }));
        const migrated = { version: 2, updatedAt: now, clearedAt: 0, items };
        safeWriteJson(STORAGE_KEYS.hist, migrated);
        return migrated;
      }
      if (raw && Array.isArray(raw.items)) {
        return {
          version: 2,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
          clearedAt: typeof raw.clearedAt === 'number' ? raw.clearedAt : 0,
          items: raw.items.filter(it => it && it.q)
        };
      }
      return { version: 2, updatedAt: 0, clearedAt: 0, items: [] };
    }

    // 3. 每日學習足跡（YYYY-MM-DD -> { wordIds, updatedAt }）
    function loadStudyLogStore() {
      const raw = safeReadJson(STORAGE_KEYS.studyLog, null);
      if (raw && raw.days && typeof raw.days === 'object') {
        return {
          version: 1,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
          days: raw.days
        };
      }
      return { version: 1, updatedAt: 0, days: {} };
    }

    // 4. 錯題庫（id -> { id, addedAt, updatedAt, wrongCount, deleted? }）
    function loadWrongBankStore() {
      const raw = safeReadJson(STORAGE_KEYS.wrongBank, null);
      if (raw && raw.items && typeof raw.items === 'object') {
        return {
          version: 1,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
          items: raw.items
        };
      }
      return { version: 1, updatedAt: 0, items: {} };
    }

    let favoritesStore = loadFavoritesStore();
    let favorites = [];
    let historyStore = loadHistoryStore();
    let historyList = [];
    let studyLogStore = loadStudyLogStore();
    let wrongBankStore = loadWrongBankStore();

    function enforceFavoritesLimit() {
      const now = Date.now();
      const active = favoritesStore.items
        .filter(it => !it.deleted)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (active.length > COLLECTION_LIMITS.favorites) {
        const overflowIds = new Set(active.slice(COLLECTION_LIMITS.favorites).map(it => it.id));
        favoritesStore.items = favoritesStore.items.map(it =>
          overflowIds.has(it.id) ? { ...it, deleted: true, updatedAt: now } : it
        );
      }
      // 保留有效收藏與最近 150 筆軟刪除標記，避免陣列無限膨脹
      const valid = favoritesStore.items.filter(it => !it.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const tombstones = favoritesStore.items.filter(it => it.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 80);
      favoritesStore.items = [...valid, ...tombstones];
    }

    function enforceWrongBankLimit() {
      const now = Date.now();
      const entries = Object.entries(wrongBankStore.items || {});
      const active = entries
        .filter(([, it]) => it && !it.deleted)
        .sort((a, b) => (b[1].updatedAt || b[1].addedAt || 0) - (a[1].updatedAt || a[1].addedAt || 0));
      if (active.length > COLLECTION_LIMITS.wrongBank) {
        active.slice(COLLECTION_LIMITS.wrongBank).forEach(([id, it]) => {
          wrongBankStore.items[id] = { ...it, deleted: true, updatedAt: now };
        });
      }
      // 僅保留最近 150 筆軟刪除標記
      const tombstones = Object.entries(wrongBankStore.items || {})
        .filter(([, it]) => it && it.deleted)
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      if (tombstones.length > 150) {
        tombstones.slice(150).forEach(([id]) => { delete wrongBankStore.items[id]; });
      }
    }

    function refreshDerivedCollections() {
      enforceFavoritesLimit();
      enforceWrongBankLimit();

      favorites = favoritesStore.items
        .filter(it => !it.deleted && (Array.isArray(it.entry) || (typeof getEntryById === 'function' && getEntryById(it.id))))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(it => Array.isArray(it.entry) ? it.entry : getEntryById(it.id))
        .filter(Boolean);

      const clearedAt = historyStore.clearedAt || 0;
      historyList = historyStore.items
        .filter(it => !it.deleted && (it.updatedAt || 0) > clearedAt)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, COLLECTION_LIMITS.history);
    }

    refreshDerivedCollections();

    // ===== 雲端同步核心控制器（支援多帳號防呆、雙向合併、背景即時寫入、登出清空）=====
    let syncPushTimer = null;
    let currentCloudUser = null;
    let firebaseRuntime = null; // { auth, db, modules }

    function setSyncBadgeState(state) {
      const badge = document.getElementById('accountSyncBadge');
      const statusText = document.getElementById('accountSyncStatusText');
      if (badge) {
        badge.classList.toggle('is-syncing', state === 'syncing');
      }
      if (statusText) {
        statusText.textContent = state === 'syncing'
          ? '正在同步資料…'
          : state === 'error'
            ? '離線暫存中（連線後自動同步）'
            : '已開啟雲端同步';
      }
    }

    let isAccountPopoverOpen = false;

    function closeAccountPopover() {
      isAccountPopoverOpen = false;
      const pop = document.getElementById('accountPopover');
      if (pop) pop.remove();
      const btn = document.getElementById('accountBtn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function openAccountPopover(user) {
      const wrap = document.getElementById('accountWrap');
      const btn = document.getElementById('accountBtn');
      if (!wrap || !user) return;
      closeAccountPopover();

      const emailText = user.email || '未提供 Email';
      const nameText = user.displayName || 'Google 帳號';
      const badge = document.getElementById('accountSyncBadge');
      const isSyncing = Boolean(badge && badge.classList.contains('is-syncing'));
      const statusLabel = isSyncing ? '正在同步資料…' : '已開啟雲端同步';

      const pop = document.createElement('div');
      pop.className = 'account-popover';
      pop.id = 'accountPopover';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', '已登入帳號資訊');
      pop.innerHTML = `
        <div class="account-pop-head">
          <img class="account-pop-avatar" src="./icons/avatar-user.png" alt="帳號頭像" />
          <div class="account-pop-info">
            <div class="account-pop-status" id="accountSyncStatusText">${escapeHtml(statusLabel)}</div>
            <div class="account-pop-name">${escapeHtml(nameText)}</div>
            <div class="account-pop-email" title="${escapeHtml(emailText)}">${escapeHtml(emailText)}</div>
          </div>
        </div>
        <button type="button" class="account-logout-btn" id="accountLogoutBtn">登出</button>
      `;

      pop.addEventListener('click', (e) => e.stopPropagation());
      pop.querySelector('#accountLogoutBtn').addEventListener('click', async () => {
        closeAccountPopover();
        await triggerGoogleSignOut();
      });

      wrap.appendChild(pop);
      isAccountPopoverOpen = true;
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    function updateAccountUi(user) {
      currentCloudUser = user || null;
      const btn = document.getElementById('accountBtn');
      const avatarImg = document.getElementById('accountAvatarImg');
      const badge = document.getElementById('accountSyncBadge');
      if (!btn) return;

      if (user) {
        const label = user.email || user.displayName || 'Google 帳號';
        btn.classList.add('is-signed-in');
        btn.title = `已登入：${label}（點擊查看帳號與登出）`;
        btn.setAttribute('aria-label', `已登入：${label}，點擊查看帳號與登出`);
        if (avatarImg) avatarImg.src = './icons/avatar-user.png';
        if (badge) badge.style.display = 'block';
        if (isAccountPopoverOpen) {
          openAccountPopover(user);
        }
      } else {
        closeAccountPopover();
        btn.classList.remove('is-signed-in');
        btn.title = '登入 Google 帳號開啟跨裝置同步';
        btn.setAttribute('aria-label', '登入 Google 帳號開啟跨裝置同步');
        btn.setAttribute('aria-expanded', 'false');
        if (avatarImg) avatarImg.src = './icons/avatar-guest.png';
        if (badge) badge.style.display = 'none';
      }
    }

    function clearAllLocalSyncedData() {
      const now = Date.now();
      favoritesStore = { version: 2, updatedAt: now, items: [] };
      favorites = [];
      historyStore = { version: 2, updatedAt: now, clearedAt: now, items: [] };
      historyList = [];
      studyLogStore = { version: 1, updatedAt: now, days: {} };
      wrongBankStore = { version: 1, updatedAt: now, items: {} };
      activeQuizState = null;

      try {
        localStorage.removeItem(STORAGE_KEYS.favs);
        localStorage.removeItem(STORAGE_KEYS.hist);
        localStorage.removeItem(STORAGE_KEYS.studyLog);
        localStorage.removeItem(STORAGE_KEYS.wrongBank);
        localStorage.removeItem(STORAGE_KEYS.dailyQuiz);
        localStorage.removeItem(STORAGE_KEYS.quizCarryover);
        localStorage.removeItem(STORAGE_KEYS.lastSyncedUid);
      } catch (e) {}

      if (typeof updateCounts === 'function') updateCounts();
      if (typeof updateQuizPendingDot === 'function') updateQuizPendingDot();
      if (typeof renderCurrentView === 'function') renderCurrentView();
    }

    function buildFirestorePayload() {
      const compactFavItems = favoritesStore.items.map(it => ({
        id: it.id,
        updatedAt: it.updatedAt || 0,
        deleted: Boolean(it.deleted)
      }));
      const dailyQuizRec = safeReadJson(STORAGE_KEYS.dailyQuiz, null);
      return {
        updatedAt: Date.now(),
        favorites: {
          version: 2,
          updatedAt: favoritesStore.updatedAt || 0,
          items: compactFavItems
        },
        history: {
          version: 2,
          updatedAt: historyStore.updatedAt || 0,
          clearedAt: historyStore.clearedAt || 0,
          items: historyStore.items.slice(0, 80)
        },
        studyLog: {
          version: 1,
          updatedAt: studyLogStore.updatedAt || 0,
          days: studyLogStore.days
        },
        wrongBank: {
          version: 1,
          updatedAt: wrongBankStore.updatedAt || 0,
          items: wrongBankStore.items
        },
        dailyQuiz: dailyQuizRec || null,
        quizCarryover: loadQuizCarryover()
      };
    }

    function applyCloudOnlySnapshot(remote) {
      const data = remote && typeof remote === 'object' ? remote : {};
      const now = Date.now();

      // 1. Favorites
      const rFavItems = (data.favorites && Array.isArray(data.favorites.items)) ? data.favorites.items : [];
      favoritesStore = {
        version: 2,
        updatedAt: (data.favorites && data.favorites.updatedAt) || now,
        items: rFavItems.filter(it => it && it.id).map(it => ({
          id: it.id,
          entry: typeof getEntryById === 'function' ? getEntryById(it.id) : null,
          updatedAt: it.updatedAt || now,
          deleted: Boolean(it.deleted)
        }))
      };
      safeWriteJson(STORAGE_KEYS.favs, favoritesStore);

      // 2. History
      const rHistItems = (data.history && Array.isArray(data.history.items)) ? data.history.items : [];
      historyStore = {
        version: 2,
        updatedAt: (data.history && data.history.updatedAt) || now,
        clearedAt: (data.history && data.history.clearedAt) || 0,
        items: rHistItems.filter(it => it && it.q)
      };
      safeWriteJson(STORAGE_KEYS.hist, historyStore);

      // 3. StudyLog
      studyLogStore = {
        version: 1,
        updatedAt: (data.studyLog && data.studyLog.updatedAt) || now,
        days: (data.studyLog && data.studyLog.days && typeof data.studyLog.days === 'object') ? data.studyLog.days : {}
      };
      safeWriteJson(STORAGE_KEYS.studyLog, studyLogStore);

      // 4. WrongBank
      wrongBankStore = {
        version: 1,
        updatedAt: (data.wrongBank && data.wrongBank.updatedAt) || now,
        items: (data.wrongBank && data.wrongBank.items && typeof data.wrongBank.items === 'object') ? data.wrongBank.items : {}
      };
      safeWriteJson(STORAGE_KEYS.wrongBank, wrongBankStore);

      // 5. DailyQuiz
      if (data.dailyQuiz && data.dailyQuiz.date) {
        safeWriteJson(STORAGE_KEYS.dailyQuiz, data.dailyQuiz);
      } else {
        try { localStorage.removeItem(STORAGE_KEYS.dailyQuiz); } catch (e) {}
      }
      if (data.quizCarryover && Array.isArray(data.quizCarryover.wordIds)) {
        saveQuizCarryover(data.quizCarryover.wordIds);
      } else {
        saveQuizCarryover([]);
      }
      activeQuizState = null;

      if (remote.quizCarryover && Array.isArray(remote.quizCarryover.wordIds)) {
        const localCo = loadQuizCarryover();
        const latestCo = (remote.quizCarryover.updatedAt || 0) >= (localCo.updatedAt || 0)
          ? remote.quizCarryover.wordIds
          : localCo.wordIds;
        saveQuizCarryover(latestCo);
      }

      refreshDerivedCollections();
      if (typeof updateCounts === 'function') updateCounts();
      if (typeof updateQuizPendingDot === 'function') updateQuizPendingDot();
      if (typeof renderCurrentView === 'function') renderCurrentView();
    }

    function mergeBidirectionalSnapshot(remote) {
      if (!remote || typeof remote !== 'object') {
        refreshDerivedCollections();
        return;
      }
      const now = Date.now();

      // 1. 收藏清單雙向合併（同 id 保留 updatedAt 較新者，含軟刪除）
      if (remote.favorites && Array.isArray(remote.favorites.items)) {
        const map = new Map();
        favoritesStore.items.forEach(it => map.set(it.id, it));
        remote.favorites.items.forEach(it => {
          if (!it || !it.id) return;
          const localIt = map.get(it.id);
          if (!localIt || (it.updatedAt || 0) > (localIt.updatedAt || 0)) {
            map.set(it.id, {
              id: it.id,
              entry: (localIt && localIt.entry) || (typeof getEntryById === 'function' ? getEntryById(it.id) : null),
              updatedAt: it.updatedAt || 0,
              deleted: Boolean(it.deleted)
            });
          }
        });
        favoritesStore = {
          version: 2,
          updatedAt: Math.max(favoritesStore.updatedAt || 0, remote.favorites.updatedAt || 0, now),
          items: [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        };
        safeWriteJson(STORAGE_KEYS.favs, favoritesStore);
      }

      // 2. 搜尋歷史雙向合併（考量 clearedAt 時間戳記與各關鍵字 updatedAt）
      if (remote.history && Array.isArray(remote.history.items)) {
        const mergedClearedAt = Math.max(historyStore.clearedAt || 0, remote.history.clearedAt || 0);
        const hMap = new Map();
        historyStore.items.forEach(it => {
          if ((it.updatedAt || 0) > mergedClearedAt) hMap.set(it.q, it);
        });
        remote.history.items.forEach(it => {
          if (!it || !it.q || (it.updatedAt || 0) <= mergedClearedAt) return;
          const localIt = hMap.get(it.q);
          if (!localIt || (it.updatedAt || 0) > (localIt.updatedAt || 0)) {
            hMap.set(it.q, it);
          }
        });
        historyStore = {
          version: 2,
          updatedAt: Math.max(historyStore.updatedAt || 0, remote.history.updatedAt || 0, now),
          clearedAt: mergedClearedAt,
          items: [...hMap.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, COLLECTION_LIMITS.history)
        };
        safeWriteJson(STORAGE_KEYS.hist, historyStore);
      }

      // 3. 每日學習足跡雙向聯集（days[YYYY-MM-DD].wordIds 聯集去重）
      if (remote.studyLog && remote.studyLog.days) {
        Object.entries(remote.studyLog.days).forEach(([day, rDay]) => {
          if (!rDay || !Array.isArray(rDay.wordIds)) return;
          const lDay = studyLogStore.days[day] || { wordIds: [], updatedAt: 0 };
          studyLogStore.days[day] = {
            wordIds: [...new Set([...lDay.wordIds, ...rDay.wordIds])],
            updatedAt: Math.max(lDay.updatedAt || 0, rDay.updatedAt || 0)
          };
        });
        studyLogStore.updatedAt = Math.max(studyLogStore.updatedAt || 0, remote.studyLog.updatedAt || 0, now);
        safeWriteJson(STORAGE_KEYS.studyLog, studyLogStore);
      }

      // 4. 錯題庫雙向合併（同 id 保留 updatedAt 較新者，含軟刪除）
      if (remote.wrongBank && remote.wrongBank.items) {
        Object.entries(remote.wrongBank.items).forEach(([id, rItem]) => {
          if (!rItem) return;
          const lItem = wrongBankStore.items[id];
          if (!lItem || (rItem.updatedAt || 0) > (lItem.updatedAt || 0)) {
            wrongBankStore.items[id] = rItem;
          }
        });
        wrongBankStore.updatedAt = Math.max(wrongBankStore.updatedAt || 0, remote.wrongBank.updatedAt || 0, now);
        safeWriteJson(STORAGE_KEYS.wrongBank, wrongBankStore);
      }

      // 5. 今日小考完成進度雙向合併（同日任一裝置已完成即同步為已完成）
      if (remote.dailyQuiz && remote.dailyQuiz.date) {
        const localQuiz = safeReadJson(STORAGE_KEYS.dailyQuiz, null);
        const rQuiz = remote.dailyQuiz;
        if (!localQuiz || rQuiz.date > localQuiz.date) {
          safeWriteJson(STORAGE_KEYS.dailyQuiz, rQuiz);
        } else if (rQuiz.date === localQuiz.date) {
          if ((rQuiz.completed && !localQuiz.completed) || ((rQuiz.updatedAt || 0) > (localQuiz.updatedAt || 0))) {
            safeWriteJson(STORAGE_KEYS.dailyQuiz, rQuiz);
          }
        }
      }

      refreshDerivedCollections();
      if (typeof updateCounts === 'function') updateCounts();
      if (typeof updateQuizPendingDot === 'function') updateQuizPendingDot();
      if (typeof renderCurrentView === 'function') renderCurrentView();
    }

    let hasPendingCloudPush = false;

    async function flushCloudSyncPush() {
      if (!hasPendingCloudPush || !currentCloudUser || !firebaseRuntime) return;
      clearTimeout(syncPushTimer);
      hasPendingCloudPush = false;
      setSyncBadgeState('syncing');
      try {
        const { db, modules } = firebaseRuntime;
        const userRef = modules.doc(db, 'users', currentCloudUser.uid);
        await modules.setDoc(userRef, buildFirestorePayload(), { merge: true });
        localStorage.setItem(STORAGE_KEYS.lastSyncedUid, currentCloudUser.uid);
        setSyncBadgeState('synced');
      } catch (err) {
        hasPendingCloudPush = true;
        setSyncBadgeState('error');
      }
    }

    function scheduleCloudSyncPush() {
      if (!currentCloudUser || !firebaseRuntime) return;
      hasPendingCloudPush = true;
      clearTimeout(syncPushTimer);
      setSyncBadgeState('syncing');
      syncPushTimer = setTimeout(() => {
        flushCloudSyncPush();
      }, 600);
    }

    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushCloudSyncPush();
    });
    window.addEventListener('pagehide', () => {
      flushCloudSyncPush();
    });
    window.addEventListener('online', () => {
      flushCloudSyncPush();
    });

    async function handleAuthenticatedUser(user) {
      updateAccountUi(user);
      if (!user || !firebaseRuntime) return;

      const uid = user.uid;
      const lastUid = localStorage.getItem(STORAGE_KEYS.lastSyncedUid) || '';
      const { db, modules } = firebaseRuntime;
      const userRef = modules.doc(db, 'users', uid);

      setSyncBadgeState('syncing');
      try {
        const snap = await modules.getDoc(userRef);
        const cloudData = snap.exists() ? snap.data() : null;

        if (!lastUid || lastUid === uid) {
          // 情況 A：首次從單機版登入，或與 lastSyncedUid 相同 → 雙向合併後回寫本地與雲端
          if (cloudData) {
            mergeBidirectionalSnapshot(cloudData);
          } else {
            refreshDerivedCollections();
          }
          await modules.setDoc(userRef, buildFirestorePayload(), { merge: true });
        } else {
          // 情況 B：同裝置切換不同帳號 → 清空本地舊帳號資料，直接載入新帳號雲端資料
          clearAllLocalSyncedData();
          if (cloudData) {
            applyCloudOnlySnapshot(cloudData);
          } else {
            await modules.setDoc(userRef, buildFirestorePayload(), { merge: true });
          }
        }

        localStorage.setItem(STORAGE_KEYS.lastSyncedUid, uid);
        setSyncBadgeState('synced');
      } catch (err) {
        setSyncBadgeState('error');
      }
    }

    let firebaseInitPromise = null;
    let firebaseInitError = null;

    async function triggerGoogleSignIn() {
      const cfg = window.YUKIYOSEI_FIREBASE_CONFIG;
      if (!cfg || !cfg.apiKey || !cfg.projectId) {
        alert('尚未設定 Firebase 雲端專案（請先於 assets/firebase-config.js 填入專案設定），目前維持本機離線儲存。');
        return;
      }
      if (!firebaseRuntime && firebaseInitPromise) {
        await firebaseInitPromise;
      }
      if (!firebaseRuntime) {
        const detail = firebaseInitError ? `\n(${firebaseInitError})` : '';
        alert(`Firebase 雲端模組載入失敗，請確認網路連線後重新整理頁面再試。${detail}`);
        return;
      }
      const { auth, modules } = firebaseRuntime;
      const provider = new modules.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await modules.signInWithPopup(auth, provider);
      } catch (err) {
        const code = err && err.code ? err.code : '';
        // 手機內建瀏覽器或 PWA 阻擋彈窗時自動改用 signInWithRedirect
        if (
          code === 'auth/popup-blocked' ||
          code === 'auth/popup-closed-by-user' ||
          code === 'auth/cancelled-popup-request' ||
          code === 'auth/operation-not-supported-in-this-environment'
        ) {
          try {
            await modules.signInWithRedirect(auth, provider);
          } catch (redirErr) {
            alert('Google 登入失敗，請稍後再試。');
          }
        } else {
          alert(`Google 登入失敗（${code || '請確認網域與登入設定'}）。`);
        }
      }
    }

    async function triggerGoogleSignOut() {
      clearTimeout(syncPushTimer);
      try {
        if (firebaseRuntime && firebaseRuntime.auth) {
          await firebaseRuntime.modules.signOut(firebaseRuntime.auth);
        }
      } catch (e) {}
      clearAllLocalSyncedData();
      updateAccountUi(null);
    }

    function initOptionalFirebaseSync() {
      const cfg = window.YUKIYOSEI_FIREBASE_CONFIG;
      if (!cfg || !cfg.apiKey || !cfg.projectId) return Promise.resolve();
      if (firebaseInitPromise) return firebaseInitPromise;

      firebaseInitPromise = (async () => {
        try {
          firebaseInitError = null;
          const [appMod, authMod, fsMod] = await Promise.all([
            import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
            import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
            import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js')
          ]);
          const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(cfg);
          const auth = authMod.getAuth(app);
          const db = fsMod.getFirestore(app);

          firebaseRuntime = {
            auth,
            db,
            modules: {
              GoogleAuthProvider: authMod.GoogleAuthProvider,
              signInWithPopup: authMod.signInWithPopup,
              signInWithRedirect: authMod.signInWithRedirect,
              getRedirectResult: authMod.getRedirectResult,
              signOut: authMod.signOut,
              onAuthStateChanged: authMod.onAuthStateChanged,
              doc: fsMod.doc,
              getDoc: fsMod.getDoc,
              setDoc: fsMod.setDoc
            }
          };

          authMod.getRedirectResult(auth).catch(() => {});
          authMod.onAuthStateChanged(auth, (user) => {
            if (user) {
              handleAuthenticatedUser(user);
            } else {
              updateAccountUi(null);
            }
          });
        } catch (e) {
          firebaseInitError = (e && e.message) ? e.message : 'SDK 載入失敗';
          firebaseInitPromise = null;
        }
      })();

      return firebaseInitPromise;
    }

    window.YukiyoseiSync = {
      exportLocalSnapshot: buildFirestorePayload,
      mergeCloudSnapshot: mergeBidirectionalSnapshot,
      syncNow: scheduleCloudSyncPush
    };

    let currentTab = 'search';
    let currentSearchOutput = { mode: 'empty', results: [], note: '' };
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const mainContent = document.getElementById('mainContent');
    const strategyArea = document.getElementById('strategyArea');
    const segmentBar = document.getElementById('segmentBar');
    const resultCountEl = document.getElementById('resultCount');
    const favCountEl = document.getElementById('favCount');
    const histCountEl = document.getElementById('histCount');

    // 版本號需與 sw.js 的 CACHE_NAME 相同；更換 data 檔案後兩邊一起加 1
    const CACHE_NAME = 'yukiyosei-v31';

    function formatMB(bytes) {
      return (bytes / 1048576).toFixed(1) + ' MB';
    }

    // 先查本機快取，沒有才下載並存起來；第一次載入後即可離線使用
    async function fetchDataCached(url) {
      if ('caches' in window) {
        try {
          const cache = await caches.open(CACHE_NAME);
          const hit = await cache.match(url);
          if (hit) return { res: hit, fromCache: true };
          const res = await fetch(url);
          if (res.ok) cache.put(url, res.clone()).catch(() => {});
          return { res, fromCache: false };
        } catch (e) { /* 快取不可用時改走一般下載 */ }
      }
      return { res: await fetch(url), fromCache: false };
    }

    async function readJsonWithProgress(res, onProgress) {
      if (!res.body || !res.body.getReader) return res.json();
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received);
      }
      return JSON.parse(await new Blob(chunks).text());
    }

    const nextPaint = () => new Promise(r => setTimeout(r, 30));

    // 狀態膠囊：loading → Importing...／ready → Offline／error → Import Failed（可點擊重試）
    let dbState = 'loading';
    function setDbStatus(state) {
      dbState = state;
      const dot = document.getElementById('statusDot');
      const txt = document.getElementById('statusText');
      const pill = document.getElementById('dbStatus');
      dot.className = 'status-dot' + (state === 'loading' ? ' loading' : state === 'error' ? ' error' : '');
      txt.textContent = state === 'loading' ? 'Importing...' : state === 'ready' ? 'Offline' : 'Import Failed';
      pill.classList.toggle('clickable', state === 'error');
      pill.setAttribute('role', state === 'error' ? 'button' : 'status');
      pill.title = state === 'error' ? '點擊重新匯入' : '';
      pill.classList.toggle('is-hidden', state === 'ready');   // 詞庫就緒（Offline）時隱藏，只在匯入中／失敗時顯示
    }
    document.getElementById('dbStatus').addEventListener('click', () => {
      if (dbState === 'error') loadDatabase();
    });

    async function loadDatabase() {
      setDbStatus('loading');
      document.getElementById('localLoaderBanner').style.display = 'none';
      try {
        const first = await fetchDataCached('./data/dict_all.json');
        if (!first.res.ok) throw new Error('dict_all.json fetch failed');
        const bridgeP = fetchDataCached('./data/zh_bridge.json').catch(() => null);

        dictData = await readJsonWithProgress(first.res, () => {});
        await nextPaint();

        const bridge = await bridgeP;
        if (bridge && bridge.res.ok) zhBridge = await bridge.res.json();

        isDbReady = true;
        resetDerivedCaches();
        refreshDerivedCollections();
        updateCounts();
        setDbStatus('ready');
        const lb = document.getElementById('localLoaderBanner');
        if (lb) lb.classList.add('is-ready');
        if (searchInput.value.trim()) performSearch(searchInput.value.trim(), false);
        else renderCurrentView();

        // 要求瀏覽器不要自動清掉這份快取，並清除舊版本
        try {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
          if ('caches' in window) {
            caches.keys().then(keys => keys
              .filter(k => k.startsWith('yukiyosei-') && k !== CACHE_NAME)
              .forEach(k => caches.delete(k)));
          }
        } catch (e) {}
      } catch (err) {
        setDbStatus('error');
        const lbErr = document.getElementById('localLoaderBanner');
        if (lbErr) { lbErr.style.display = 'flex'; lbErr.classList.remove('is-ready'); }
        mainContent.innerHTML = `
          <div class="empty-state">
            <strong>尚未載入詞庫檔案</strong>
            <p>若您直接雙擊開啟 HTML，請點擊下方按鈕同時選取 <code>data/dict_all.json</code> 與 <code>data/zh_bridge.json</code>；若部署至網頁空間則會自動載入。也可以點右上角的 Import Failed 重新匯入。</p>
          </div>
        `;
      }
    }

    document.getElementById('jsonFileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      setDbStatus('loading');

      for (const file of files) {
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            dictData = parsed;
            isDbReady = true;
          } else if (parsed && typeof parsed === 'object') {
            zhBridge = parsed;
          }
        } catch (err) {
          alert(`讀取 ${file.name} 失敗，請確認選擇正確的 JSON 檔案。`);
        }
      }
      if (isDbReady) {
        resetDerivedCaches();
        refreshDerivedCollections();
        updateCounts();
        setDbStatus('ready');
        const lbMan = document.getElementById('localLoaderBanner');
        if (lbMan) { lbMan.style.display = 'flex'; lbMan.classList.add('is-ready'); }
        if (searchInput.value.trim()) performSearch(searchInput.value.trim(), false);
        else renderCurrentView();
      } else {
        setDbStatus('error');
      }
    });

    function hasKana(str) {
      return /[\u3040-\u309F\u30A0-\u30FF]/.test(str);
    }

    function isAsciiEnglish(str) {
      return /^[a-zA-Z0-9\s\-']+$/.test(str);
    }

    function hasHanzi(str) {
      return /[\u4E00-\u9FFF]/.test(str);
    }


    // ===== 數字處理：阿拉伯數字 -> 日文漢數字／讀音 =====
    const KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const DIGIT_READ = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
    const UNIT_KANJI = ['', '万', '億', '兆', '京'];
    const UNIT_READ = ['', 'まん', 'おく', 'ちょう', 'けい'];

    function normalizeDigits(str) {
      return str
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[,，\s]/g, '');
    }

    function isNumericQuery(str) {
      return /^[0-9０-９][0-9０-９,，]*$/.test(str.trim());
    }

    // 1~9999 -> { k: 漢數字, r: 讀音 }；isLead 表示是否為整個數字的最前面
    function group4ToJapanese(v, isLead) {
      const th = Math.floor(v / 1000) % 10;
      const h = Math.floor(v / 100) % 10;
      const t = Math.floor(v / 10) % 10;
      const o = v % 10;
      let k = '', r = '';

      if (th) {
        if (th === 1) {
          if (isLead) { k += '千'; r += 'せん'; }
          else { k += '一千'; r += 'いっせん'; }
        } else {
          k += KANJI_DIGITS[th] + '千';
          r += th === 3 ? 'さんぜん' : th === 8 ? 'はっせん' : DIGIT_READ[th] + 'せん';
        }
      }
      if (h) {
        if (h === 1) { k += '百'; r += 'ひゃく'; }
        else {
          k += KANJI_DIGITS[h] + '百';
          r += h === 3 ? 'さんびゃく' : h === 6 ? 'ろっぴゃく' : h === 8 ? 'はっぴゃく' : DIGIT_READ[h] + 'ひゃく';
        }
      }
      if (t) {
        if (t === 1) { k += '十'; r += 'じゅう'; }
        else { k += KANJI_DIGITS[t] + '十'; r += DIGIT_READ[t] + 'じゅう'; }
      }
      if (o) { k += KANJI_DIGITS[o]; r += DIGIT_READ[o]; }
      return { k, r };
    }

    function numberToJapanese(raw) {
      const s = normalizeDigits(raw);
      if (!/^\d+$/.test(s) || s.length > 20) return null;
      if (s.length > 1 && s[0] === '0') return null;

      const fullwidth = s.replace(/\d/g, d => String.fromCharCode(d.charCodeAt(0) + 0xFEE0));
      const positional = s.replace(/\d/g, d => KANJI_DIGITS[+d]);
      const n = BigInt(s);

      if (n === 0n) {
        return { digits: s, fullwidth, positional, kanji: '零', alt: '〇', reading: 'ゼロ・れい' };
      }

      const groups = [];
      let rem = n;
      while (rem > 0n) { groups.push(Number(rem % 10000n)); rem = rem / 10000n; }

      let kanji = '', reading = '';
      for (let i = groups.length - 1; i >= 0; i--) {
        const v = groups[i];
        if (!v) continue;
        const isLead = kanji === '';
        const g = group4ToJapanese(v, isLead);
        let r = g.r;
        // 兆、京 前的促音化（いっちょう、はっちょう、じゅっちょう…）
        if (i === 3) {
          r = r.replace(/いち$/, 'いっ').replace(/はち$/, 'はっ').replace(/じゅう$/, 'じゅっ');
        } else if (i === 4) {
          r = r.replace(/いち$/, 'いっ').replace(/はち$/, 'はっ').replace(/じゅう$/, 'じゅっ')
               .replace(/ろく$/, 'ろっ').replace(/ひゃく$/, 'ひゃっ');
        }
        kanji += g.k + UNIT_KANJI[i];
        reading += r + UNIT_READ[i];
      }
      return { digits: s, fullwidth, positional, kanji, alt: '', reading };
    }

    function searchNumber(q, info) {
      const kanjiTargets = new Set([info.fullwidth, info.digits, info.kanji]);
      if (info.alt) kanjiTargets.add(info.alt);
      const glossTargets = new Set([info.digits, BigInt(info.digits).toLocaleString('en-US')]);

      const byKanji = [];
      const byGloss = [];
      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        if (entry[0].some(k => kanjiTargets.has(k))) {
          byKanji.push(entry);
          continue;
        }
        if (byGloss.length < 30) {
          const senses = entry[3];
          let hit = false;
          for (let j = 0; j < senses.length && !hit; j++) {
            hit = senses[j].g.some(g => glossTargets.has(g.trim()));
          }
          if (hit) byGloss.push(entry);
        }
      }
      byKanji.sort((a, b) => b[2] - a[2]);
      byGloss.sort((a, b) => b[2] - a[2]);
      return {
        mode: 'num',
        badge: '數字 → 日文',
        note: `「${q}」的日文數字寫法與讀法`,
        numberInfo: info,
        results: [...byKanji, ...byGloss].slice(0, 50)
      };
    }

    // ===== 線上翻譯備援（詞庫查不到時使用）=====
    const translateCache = new Map();
    let searchToken = 0;
    let translateTimer = null;

    function fetchWithTimeout(url, ms = 7000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    }

    async function translateViaGoogle(text, from, to) {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
        + `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error('google ' + res.status);
      const data = await res.json();
      const out = (data[0] || []).map(seg => seg[0]).join('').trim();
      if (!out) throw new Error('google empty');
      return out;
    }

    async function translateViaMyMemory(text, from, to) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from + '|' + to)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error('mymemory ' + res.status);
      const data = await res.json();
      const out = ((data.responseData && data.responseData.translatedText) || '').trim();
      if (!out || String(data.responseStatus) !== '200') throw new Error('mymemory empty');
      return out;
    }

    async function translateText(text, from, to) {
      const key = `${from}|${to}|${text}`;
      if (translateCache.has(key)) return translateCache.get(key);
      let result;
      if (getAiSegmentEndpoint()) {
        try {
          const aiRes = await requestAiTranslate(text, from, to);
          result = { text: aiRes.text, reading: aiRes.reading, engine: 'Gemini AI' };
          translateCache.set(key, result);
          return result;
        } catch (aiErr) {
          // AI 暫時不可用時自動退回免費翻譯保底
        }
      }
      try {
        result = { text: await translateViaGoogle(text, from, to), engine: 'Google 翻譯' };
      } catch (e1) {
        result = { text: await translateViaMyMemory(text, from, to), engine: 'MyMemory' };
      }
      translateCache.set(key, result);
      return result;
    }

    const LANG_LABEL = { 'ja': '日文', 'en': '英文', 'zh-TW': '中文' };

    // 日文 -> 英文；中文／英文 -> 日文
    async function translateFallback(q) {
      let from, to;
      if (hasKana(q)) { from = 'ja'; to = 'en'; }
      else if (hasHanzi(q)) { from = 'zh-TW'; to = 'ja'; }
      else { from = 'en'; to = 'ja'; }

      let r = await translateText(q, from, to);
      // 純漢字詞翻回來一樣 -> 其實是日文漢字，改翻成英文
      if (to === 'ja' && r.text === q.trim()) {
        from = 'ja'; to = 'en';
        r = await translateText(q, from, to);
      }

      let matches = [];
      if (to === 'ja') {
        const parts = [...new Set(r.text.split(/[；;、／/,]+/).map(s => s.trim()).filter(Boolean))];
        const seenIds = new Set();
        for (const p of (parts.length > 0 ? parts : [r.text])) {
          const lookup = executeSmartSearch(p);
          if (lookup.mode === 'jp') {
            for (const item of lookup.results) {
              const id = getEntryId(item);
              if (!seenIds.has(id)) {
                seenIds.add(id);
                matches.push(item);
                if (matches.length >= 8) break;
              }
            }
          }
          if (matches.length >= 8) break;
        }
      }
      return { text: r.text, engine: r.engine, from, to, matches };
    }

    function startTranslate(query, token) {
      clearTimeout(translateTimer);
      translateTimer = setTimeout(async () => {
        if (token !== searchToken) return;
        try {
          const res = await translateFallback(query);
          if (token !== searchToken) return;
          currentSearchOutput.translate = { state: 'done', query, ...res };
        } catch (err) {
          if (token !== searchToken) return;
          currentSearchOutput.translate = { state: 'error', query };
        }
        if (currentTab === 'search') renderCurrentView();
      }, 450);
    }

    function renderNumberCard(info) {
      const card = document.createElement('article');
      card.className = 'word-card number-card';
      const rows = [
        ['漢數字', info.kanji + (info.alt ? `（${info.alt}）` : '')],
        ['讀音', info.reading],
        ['全形', info.fullwidth],
        ['逐字寫法', info.positional]
      ];
      card.innerHTML = `
        <div class="num-head">
          <span class="num-arabic">${escapeHtml(BigInt(info.digits).toLocaleString('en-US'))}</span>
          <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(info.reading.split('・')[0])}">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
          </button>
        </div>
        ${rows.map(([label, val]) => `
          <div class="num-row"><span class="num-label">${label}</span><span class="num-val">${escapeHtml(val)}</span></div>
        `).join('')}
      `;
      card.querySelector('[data-speak]').addEventListener('click', e => speakJapanese(e.currentTarget.getAttribute('data-speak')));
      return card;
    }

    function renderTranslateBlock(t) {
      const wrap = document.createElement('div');
      if (t.state === 'loading') {
        wrap.innerHTML = `<div class="empty-state"><strong>詞庫找不到，正在翻譯…</strong></div>`;
        return wrap;
      }
      if (t.state === 'error') {
        wrap.innerHTML = `<div class="empty-state"><strong>找不到相符的單字，翻譯也失敗了</strong><p>線上翻譯需要網路連線，請確認網路後重新搜尋。</p></div>`;
        return wrap;
      }
      const card = document.createElement('article');
      card.className = 'word-card translate-card';
      const speakBtn = t.to === 'ja' ? `
        <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(t.text)}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
        </button>` : '';
      card.innerHTML = `
        <div class="tr-dir">${LANG_LABEL[t.from] || t.from} → ${LANG_LABEL[t.to] || t.to} · ${escapeHtml(t.engine)}（機器翻譯，僅供參考）</div>
        <div class="tr-src">${escapeHtml(t.query)}</div>
        <div class="tr-out-row">
          <div class="tr-out">${escapeHtml(t.text)}</div>
          ${speakBtn}
        </div>
      `;
      const sp = card.querySelector('[data-speak]');
      if (sp) sp.addEventListener('click', () => speakJapanese(sp.getAttribute('data-speak')));
      wrap.appendChild(card);

      if (t.matches && t.matches.length > 0) {
        const label = document.createElement('div');
        label.className = 'tr-related-label';
        label.textContent = `詞庫中「${t.text}」的相關詞條`;
        wrap.appendChild(label);
        wrap.appendChild(renderWordCards(t.matches));
      }
      return wrap;
    }



    // ===== 假名轉換 =====
    function toKatakana(str) {
      return str.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
    }
    function toHiragana(str) {
      return str.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    }
    function kanaVariants(q) {
      const v = new Set([q]);
      if (/^[\u3041-\u3096ー]+$/.test(q)) v.add(toKatakana(q));
      else if (/^[\u30A1-\u30F6ー]+$/.test(q)) v.add(toHiragana(q));
      // 含長音符號 ー 的混合輸入（すきー場、らーめん屋、スきー）：平假名自動轉成片假名一起比對
      else if (q.includes('ー') && /[\u3041-\u3096]/.test(q)) v.add(toKatakana(q));
      return [...v];
    }

    // ===== 羅馬拼音 -> 平假名 =====
    const ROMA = {};
    (function buildRoma() {
      const V = 'aiueo';
      'あいうえお'.split('').forEach((k, i) => { ROMA[V[i]] = k; });
      const rows = {
        k: 'かきくけこ', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', h: 'はひふへほ',
        m: 'まみむめも', r: 'らりるれろ', g: 'がぎぐげご', z: 'ざじずぜぞ', d: 'だぢづでど',
        b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ'
      };
      Object.keys(rows).forEach(c => rows[c].split('').forEach((k, i) => { ROMA[c + V[i]] = k; }));
      ROMA.ya = 'や'; ROMA.yu = 'ゆ'; ROMA.yo = 'よ'; ROMA.wa = 'わ'; ROMA.wo = 'を';
      ROMA.shi = 'し'; ROMA.chi = 'ち'; ROMA.tsu = 'つ'; ROMA.fu = 'ふ'; ROMA.ji = 'じ';
      const small = { a: 'ゃ', u: 'ゅ', o: 'ょ', e: 'ぇ' };
      [['ky', 'き'], ['gy', 'ぎ'], ['sh', 'し'], ['sy', 'し'], ['ch', 'ち'], ['cy', 'ち'], ['ty', 'ち'],
       ['ny', 'に'], ['hy', 'ひ'], ['my', 'み'], ['ry', 'り'], ['by', 'び'], ['py', 'ぴ'],
       ['j', 'じ'], ['jy', 'じ'], ['zy', 'じ'], ['dy', 'ぢ']].forEach(([pre, base]) => {
        Object.keys(small).forEach(v => {
          const key = pre + v;
          // 'ja','ju','jo' 是じゃ/じゅ/じょ；'je' 是じぇ
          ROMA[key] = base + small[v];
        });
      });
      ROMA.fa = 'ふぁ'; ROMA.fi = 'ふぃ'; ROMA.fe = 'ふぇ'; ROMA.fo = 'ふぉ';
    })();

    function romajiToKana(input) {
      let s = input.toLowerCase().trim();
      if (s.length < 2 || /[^a-zāīūēō'\-]/.test(s)) return null;
      s = s.replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu').replace(/ē/g, 'ee').replace(/ō/g, 'ou');
      if (!s.replace(/-/g, '')) return null;
      let out = '';
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        const nx = s[i + 1];
        if (c === "'") { i++; continue; }
        // 連字號 ＝ 長音符號（suki- → すきー → スキー），不能直接丟掉否則會變成「好き」
        if (c === '-') { if (out && !out.endsWith('ー')) out += 'ー'; i++; continue; }
        if (c === 'n') {
          if (nx === "'") { out += 'ん'; i += 2; continue; }
          if (nx === undefined || !/[aiueoy]/.test(nx)) { out += 'ん'; i++; continue; }
        }
        // 促音：子音重複（不含 n），以及 tch
        if (nx && c === nx && /[bcdfghjkmpqrstvwxyz]/.test(c)) { out += 'っ'; i++; continue; }
        if (c === 't' && s.startsWith('tch', i)) { out += 'っ'; i++; continue; }
        let matched = false;
        for (const len of [3, 2, 1]) {
          const sub = s.substr(i, len);
          if (sub.length === len && ROMA[sub]) { out += ROMA[sub]; i += len; matched = true; break; }
        }
        if (!matched) return null;
      }
      return out;
    }

    // ===== 活用形還原 =====
    const RANUKI = '去ら詞（口語可能形）';
    const RULES = [];
    function R(from, to, inT, outT, label, needTag) {
      RULES.push({ from, to, inT, outT, label, needTag });
    }
    const FIN = ['*'];          // 只用在表面形
    const DER = ['*', 'v1'];    // 也可用在已還原一層的一段動詞（可能／被動／使役…）
    const TEI = ['*', 'te'];    // て形或「ている」等複合形
    const ADJ = ['*', 'adji'];

    (function buildRules() {
      // --- 一段動詞 ---
      R('ない', 'る', FIN, 'v1', 'ない形（否定）');
      R('なかった', 'る', FIN, 'v1', 'なかった形（過去否定）');
      R('ます', 'る', FIN, 'v1', 'ます形（禮貌）');
      R('ました', 'る', FIN, 'v1', 'ました（禮貌過去）');
      R('ません', 'る', FIN, 'v1', 'ません（禮貌否定）');
      R('ませんでした', 'る', FIN, 'v1', 'ませんでした（禮貌過去否定）');
      R('た', 'る', FIN, 'v1', 'た形（過去）');
      R('て', 'る', TEI, 'v1', 'て形');
      R('れば', 'る', FIN, 'v1', 'ば形（假設）');
      R('よう', 'る', FIN, 'v1', '意志形');
      R('ろ', 'る', FIN, 'v1', '命令形');
      R('られる', 'る', DER, 'v1', '可能／被動形');
      R('させる', 'る', DER, 'v1', '使役形');
      R('させられる', 'る', DER, 'v1', '使役被動形');
      R('たい', 'る', ADJ, 'v1', 'たい形（想…）');

      // --- 五段動詞 ---
      const G = [
        ['う', 'わ', 'い', 'え', 'お', 'って', 'った'],
        ['く', 'か', 'き', 'け', 'こ', 'いて', 'いた'],
        ['ぐ', 'が', 'ぎ', 'げ', 'ご', 'いで', 'いだ'],
        ['す', 'さ', 'し', 'せ', 'そ', 'して', 'した'],
        ['つ', 'た', 'ち', 'て', 'と', 'って', 'った'],
        ['ぬ', 'な', 'に', 'ね', 'の', 'んで', 'んだ'],
        ['ぶ', 'ば', 'び', 'べ', 'ぼ', 'んで', 'んだ'],
        ['む', 'ま', 'み', 'め', 'も', 'んで', 'んだ'],
        ['る', 'ら', 'り', 'れ', 'ろ', 'って', 'った']
      ];
      G.forEach(([u, a, i, e, o, te, ta]) => {
        R(a + 'ない', u, FIN, 'v5', 'ない形（否定）');
        R(a + 'なかった', u, FIN, 'v5', 'なかった形（過去否定）');
        R(i + 'ます', u, FIN, 'v5', 'ます形（禮貌）');
        R(i + 'ました', u, FIN, 'v5', 'ました（禮貌過去）');
        R(i + 'ません', u, FIN, 'v5', 'ません（禮貌否定）');
        R(i + 'ませんでした', u, FIN, 'v5', 'ませんでした（禮貌過去否定）');
        R(i + 'たい', u, ADJ, 'v5', 'たい形（想…）');
        R(e + 'ば', u, FIN, 'v5', 'ば形（假設）');
        R(o + 'う', u, FIN, 'v5', '意志形');
        R(e, u, FIN, 'v5', '命令形');
        R(te, u, TEI, 'v5', 'て形');
        R(ta, u, FIN, 'v5', 'た形（過去）');
        R(a + 'れる', u, DER, 'v5', '被動形');
        R(a + 'せる', u, DER, 'v5', '使役形');
        R(e + 'る', u, DER, 'v5', '可能形');
        R(a + 'せられる', u, DER, 'v5', '使役被動形');
        if (u !== 'す') R(a + 'される', u, DER, 'v5', '使役被動形');
      });
      // 特殊五段：行く、問う、ある型（いらっしゃる等）
      R('って', 'く', TEI, 'v5', 'て形', 'v5k-s');
      R('った', 'く', FIN, 'v5', 'た形（過去）', 'v5k-s');
      R('うて', 'う', TEI, 'v5', 'て形', 'v5u-s');
      R('うた', 'う', FIN, 'v5', 'た形（過去）', 'v5u-s');
      R('います', 'る', FIN, 'v5', 'ます形（禮貌）', 'v5aru');
      R('いました', 'る', FIN, 'v5', 'ました（禮貌過去）', 'v5aru');
      R('いません', 'る', FIN, 'v5', 'ません（禮貌否定）', 'v5aru');
      R('いませんでした', 'る', FIN, 'v5', 'ませんでした（禮貌過去否定）', 'v5aru');

      // --- する／来る ---
      [['しない', 'ない形（否定）'], ['しなかった', 'なかった形（過去否定）'], ['します', 'ます形（禮貌）'],
       ['しました', 'ました（禮貌過去）'], ['しません', 'ません（禮貌否定）'],
       ['しませんでした', 'ませんでした（禮貌過去否定）'], ['した', 'た形（過去）'], ['すれば', 'ば形（假設）'],
       ['しよう', '意志形'], ['しろ', '命令形']].forEach(([f, l]) => R(f, 'する', FIN, 'vs', l));
      R('して', 'する', TEI, 'vs', 'て形');
      R('したい', 'する', ADJ, 'vs', 'たい形（想…）');
      R('できる', 'する', FIN, 'vs', '可能形');
      R('される', 'する', FIN, 'vs', '被動形');
      R('させる', 'する', FIN, 'vs', '使役形');

      [['こ', 'き', 'く'], ['来', '来', '来']].forEach(([ko, ki, ku]) => {
        R(ko + 'ない', ku + 'る', FIN, 'vk', 'ない形（否定）');
        R(ko + 'なかった', ku + 'る', FIN, 'vk', 'なかった形（過去否定）');
        R(ki + 'ます', ku + 'る', FIN, 'vk', 'ます形（禮貌）');
        R(ki + 'ました', ku + 'る', FIN, 'vk', 'ました（禮貌過去）');
        R(ki + 'ません', ku + 'る', FIN, 'vk', 'ません（禮貌否定）');
        R(ki + 'た', ku + 'る', FIN, 'vk', 'た形（過去）');
        R(ki + 'て', ku + 'る', TEI, 'vk', 'て形');
        R(ku + 'れば', ku + 'る', FIN, 'vk', 'ば形（假設）');
        R(ko + 'よう', ku + 'る', FIN, 'vk', '意志形');
        R(ko + 'い', ku + 'る', FIN, 'vk', '命令形');
        R(ko + 'られる', ku + 'る', FIN, 'vk', '可能／被動形');
        R(ko + 'させる', ku + 'る', FIN, 'vk', '使役形');
        R(ki + 'たい', ku + 'る', ADJ, 'vk', 'たい形（想…）');
      });

      // --- い形容詞 ---
      R('くない', 'い', FIN, 'adji', '否定');
      R('くなかった', 'い', FIN, 'adji', '過去否定');
      R('かった', 'い', FIN, 'adji', '過去');
      R('くて', 'い', FIN, 'adji', 'て形');
      R('く', 'い', FIN, 'adji', '副詞形');
      R('ければ', 'い', FIN, 'adji', 'ば形（假設）');
      R('さ', 'い', FIN, 'adji', '名詞化（…度）');
      R('かったです', 'い', FIN, 'adji', '禮貌過去');
      R('くありません', 'い', FIN, 'adji', '禮貌否定');
      R('です', '', FIN, 'adji', '禮貌');

      // --- 複合形：て形 + 補助動詞（ている、てしまう…）→ 先還原成 て形 ---
      const AUX = [
        ['いる', 'いる', 'ている（進行／持續）'], ['います', 'います', 'ている（進行／持續）'],
        ['いた', 'いた', 'ていた（過去進行）'], ['いました', 'いました', 'ていた（過去進行）'],
        ['いない', 'いない', 'ていない（尚未／沒在…）'], ['いません', 'いません', 'ていない（尚未／沒在…）'],
        ['いなかった', 'いなかった', 'ていない（尚未／沒在…）'],
        ['る', 'る', 'ている（口語）'], ['た', 'た', 'ていた（口語）'], ['ない', 'ない', 'ていない（口語）'],
        ['ます', 'ます', 'ている（口語）'], ['ました', 'ました', 'ていた（口語）'],
        ['みる', 'みる', 'てみる（試著…）'], ['みた', 'みた', 'てみる（試著…）'],
        ['みます', 'みます', 'てみる（試著…）'], ['みました', 'みました', 'てみる（試著…）'],
        ['おく', 'おく', 'ておく（先…好）'], ['おいた', 'おいた', 'ておく（先…好）'],
        ['おきます', 'おきます', 'ておく（先…好）'],
        ['しまう', 'しまう', 'てしまう（…掉／完了）'], ['しまった', 'しまった', 'てしまう（…掉／完了）'],
        ['しまいます', 'しまいます', 'てしまう（…掉／完了）'], ['しまいました', 'しまいました', 'てしまう（…掉／完了）'],
        ['いく', 'いく', 'ていく'], ['いった', 'いった', 'ていく'], ['いきます', 'いきます', 'ていく'],
        ['くる', 'くる', 'てくる'], ['きた', 'きた', 'てくる'], ['きます', 'きます', 'てくる'],
        ['ください', 'ください', 'てください（請…）']
      ];
      ['て', 'で'].forEach(t => AUX.forEach(([suf, , label]) => R(t + suf, t, FIN, 'te', label)));
      [['ちゃう', 'て'], ['ちゃった', 'て'], ['ちゃいます', 'て'], ['じゃう', 'で'], ['じゃった', 'で'], ['じゃいます', 'で']]
        .forEach(([f, t]) => R(f, t, FIN, 'te', 'ちゃう（口語：…掉）'));

      // --- 敬語命令形（ください、なさい、いらっしゃい…）與「なさい」 ---
      R('い', 'る', FIN, 'v5', '命令形（敬語）', 'v5aru');
      R('なさい', 'る', FIN, 'v1', 'なさい形（請…）');
      G.forEach(([u, a, i]) => R(i + 'なさい', u, FIN, 'v5', 'なさい形（請…）'));
      R('しなさい', 'する', FIN, 'vs', 'なさい形（請…）');
      R('きなさい', 'くる', FIN, 'vk', 'なさい形（請…）');
      R('来なさい', '来る', FIN, 'vk', 'なさい形（請…）');

      // --- いい系：かっこよくない → かっこいい ---
      [['よくない', '否定'], ['よくなかった', '過去否定'], ['よかった', '過去'], ['よくて', 'て形'],
       ['よく', '副詞形'], ['よければ', 'ば形（假設）']].forEach(([f, l]) => R(f, 'いい', FIN, 'adji', l));

      // --- 去ら詞：食べれる（正式為 食べられる）---
      R('れる', 'る', DER, 'v1', RANUKI);
      R('これる', 'くる', FIN, 'vk', RANUKI);
      R('来れる', '来る', FIN, 'vk', RANUKI);

      // --- な形容詞：變化的其實是後面的「だ」，這裡還原到詞幹 ---
      [['だった', '＋だ的過去（…だった）'], ['ではなかった', '＋だ的過去否定'], ['じゃなかった', '＋だ的過去否定'],
       ['ではない', '＋だ的否定'], ['じゃない', '＋だ的否定'], ['ではありません', '＋です的否定'],
       ['でした', '＋です的過去'], ['です', '＋です（禮貌）'], ['だ', '＋だ（斷定）'], ['で', '＋で（て形）'],
       ['に', '＋に（副詞形）'], ['な', '＋な（修飾名詞）'], ['なら', '＋なら（假設）'], ['さ', '名詞化（…度）']]
        .forEach(([f, l]) => R(f, '', FIN, 'adjna', l));
    })();

    function inflectionExtra(inf) {
      if (inf.path.includes(RANUKI)) {
        const b = inf.base;
        const formal = b.endsWith('くる') ? b.slice(0, -2) + 'こられる' : b.slice(0, -1) + 'られる';
        return `（正式寫法：${formal}）`;
      }
      return '';
    }

    function deinflect(q) {
      const found = [];
      const seen = new Set();
      const queue = [{ str: q, type: '*', path: [], needTag: null }];
      while (queue.length) {
        const st = queue.shift();
        if (st.path.length >= 4) continue;
        for (let r = 0; r < RULES.length; r++) {
          const rule = RULES[r];
          if (!st.str.endsWith(rule.from)) continue;
          if (!rule.inT.includes(st.type)) continue;
          const ns = st.str.slice(0, st.str.length - rule.from.length) + rule.to;
          if (!ns) continue;
          const key = ns + '|' + rule.outT + '|' + (rule.needTag || st.needTag || '');
          if (seen.has(key)) continue;
          seen.add(key);
          const nst = { str: ns, type: rule.outT, path: [...st.path, rule.label], needTag: rule.needTag || st.needTag };
          found.push(nst);
          queue.push(nst);
        }
      }
      return found;
    }

    const V5END = { 'v5u': 'う', 'v5u-s': 'う', 'v5k': 'く', 'v5k-s': 'く', 'v5g': 'ぐ', 'v5s': 'す', 'v5t': 'つ',
      'v5n': 'ぬ', 'v5b': 'ぶ', 'v5m': 'む', 'v5r': 'る', 'v5r-i': 'る', 'v5aru': 'る', 'v5uru': 'る' };

    function entryTagSet(entry) {
      const t = new Set();
      entry[3].forEach(sn => (sn.p || []).forEach(x => t.add(x)));
      return t;
    }

    function inflectionPosOk(tags, cand, form) {
      if (cand.needTag && !tags.has(cand.needTag)) return false;
      switch (cand.type) {
        case 'v1': return form.endsWith('る') && (tags.has('v1') || tags.has('v1-s'));
        case 'v5': {
          const last = form.slice(-1);
          for (const t of tags) if (V5END[t] === last) return true;
          return false;
        }
        case 'vk': return (form.endsWith('くる') || form.endsWith('来る')) && tags.has('vk');
        case 'adji': return form.endsWith('い') && (tags.has('adj-i') || tags.has('adj-ix'));
        case 'adjna': return tags.has('adj-na');
        case 'vs':
          if (form.endsWith('する')) return tags.has('vs-i') || tags.has('vs-s');
          return tags.has('vs');
      }
      return false;
    }

    // 先由輸入字產生「可能的原形」對照表；之後在掃描詞庫時順便比對
    function buildInflectionMap(q) {
      if (q.length < 2) return null;
      const cands = deinflect(q).filter(c => ['v1', 'v5', 'vs', 'vk', 'adji', 'adjna'].includes(c.type));
      if (!cands.length) return null;
      const map = new Map();
      const add = (k, c) => { if (!map.has(k)) map.set(k, []); map.get(k).push(c); };
      cands.forEach(c => {
        add(c.str, c);
        if (c.type === 'vs' && c.str.endsWith('する') && c.str.length > 2) add(c.str.slice(0, -2), c);
      });
      return map;
    }

    // 回傳 { entry, path, base }（同一詞條只保留最短路徑），沒有命中回傳 null
    function matchInflection(entry, map) {
      let best = null;
      let tags = null;
      for (let part = 0; part < 2; part++) {
        const forms = entry[part];
        for (let f = 0; f < forms.length; f++) {
          const list = map.get(forms[f]);
          if (!list) continue;
          if (!tags) tags = entryTagSet(entry);
          for (let c = 0; c < list.length; c++) {
            const cand = list[c];
            if (inflectionPosOk(tags, cand, forms[f]) && (!best || cand.path.length < best.path.length)) {
              best = { entry, path: cand.path, base: forms[f] };
            }
          }
        }
      }
      return best;
    }

    // ===== 同音／同形詞的常用度排序（離線）=====
    // 詞庫只有一個 common 旗標、沒有 ichi1／spec1／news1 這類細項標籤，所以分兩種情況：
    //  1. 詞條若帶有優先度標籤（entry[5]，例如 ['ichi1','news1','nf05']）就依標籤分級：
    //     ichi1／spec1 > gai1 > news1 > ichi2／spec2／gai2 > news2，同級再用 nfNN（越小越常用）
    //  2. 沒有標籤時改用內建訊號估算日常使用頻率：詞在詞庫例句語料中的獨立出現次數、
    //     例句數與義項數、命中的是不是第一讀音，再加上 common 旗標；後綴／助數詞等附屬詞略降
    const PRI_TAG_SCORE = { ichi1: 200, spec1: 200, gai1: 180, news1: 160, ichi2: 100, spec2: 100, gai2: 100, news2: 80 };
    const BOUND_POS = new Set(['suf', 'pref', 'n-suf', 'n-pref', 'ctr']);
    const RE_KANJI = /[\u3400-\u9FFF\uF900-\uFAFF]/;
    const RE_KATA = /[\u30A0-\u30FF]/;
    let exampleCorpus = null;
    const formFreqCache = new Map();
    let coreBaseCache = new WeakMap();

    let entryByIdCache = null;
    function resetDerivedCaches() {
      exampleCorpus = null;
      formFreqCache.clear();
      coreBaseCache = new WeakMap();
      dailyThemesCache = null;
      dailyCommonCache = null;
      segIndex = null;
      entryByIdCache = null;
    }

    function getEntryById(id) {
      if (!id) return null;
      if (!entryByIdCache && Array.isArray(dictData) && dictData.length > 0) {
        const map = new Map();
        for (let i = 0; i < dictData.length; i++) {
          const e = dictData[i];
          const eid = getEntryId(e);
          if (eid && !map.has(eid)) map.set(eid, e);
        }
        entryByIdCache = map;
      }
      if (entryByIdCache && entryByIdCache.has(id)) return entryByIdCache.get(id);
      const favItem = favoritesStore.items.find(it => it.id === id);
      return favItem ? favItem.entry : null;
    }

    function priorityTagBonus(entry) {
      const tags = entry[5];
      if (!Array.isArray(tags) || !tags.length) return 0;
      let best = 0, nf = 0;
      for (const t of tags) {
        if (PRI_TAG_SCORE[t] > best) best = PRI_TAG_SCORE[t];
        const m = /^nf(\d+)$/.exec(t);
        if (m) nf = Math.max(nf, (49 - Number(m[1])) / 48 * 20);
      }
      return best + nf;
    }

    function getExampleCorpus() {
      if (exampleCorpus) return exampleCorpus;
      const seen = new Set();
      for (const e of dictData) for (const s of e[3]) if (s.e) for (const x of s.e) seen.add(x[0]);
      exampleCorpus = '\n' + [...seen].join('\n') + '\n';
      return exampleCorpus;
    }

    // 詞在例句語料中的出現次數。單一漢字只算「前後都不是漢字」的獨立用法（避免「東京」被算進「京」）；
    // 純平假名太容易夾在其他詞裡，無法可靠計次，一律當 0。
    function formFreq(form) {
      let n = formFreqCache.get(form);
      if (n !== undefined) return n;
      let guard = null;
      if (RE_KANJI.test(form)) { if (form.length === 1) guard = RE_KANJI; }
      else if (RE_KATA.test(form) && form.length >= 3) guard = RE_KATA;
      else { formFreqCache.set(form, 0); return 0; }
      n = 0;
      const c = getExampleCorpus();
      let i = -1;
      while ((i = c.indexOf(form, i + 1)) >= 0) {
        if (guard && (guard.test(c[i - 1]) || guard.test(c[i + form.length]))) continue;
        n++;
      }
      formFreqCache.set(form, n);
      return n;
    }

    // 與查詢字無關的基礎分（不含語料次數，算得快）
    function coreBase(entry) {
      let v = coreBaseCache.get(entry);
      if (v !== undefined) return v;
      let ex = 0;
      const pos = new Set();
      entry[3].forEach(s => { if (s.e) ex += s.e.length; (s.p || []).forEach(p => pos.add(p)); });
      const bound = pos.size > 0 && [...pos].every(p => BOUND_POS.has(p));
      v = (entry[2] ? 25 : 0) + priorityTagBonus(entry) + Math.min(ex, 4) * 3 + Math.min(entry[3].length, 6) * 1.5 - (bound ? 8 : 0);
      coreBaseCache.set(entry, v);
      return v;
    }

    // 漢字表記與片假名讀音（拉麺／ラーメン、珈琲／コーヒー）都算進去；非常用的同形詞（如結構用語 ラーメン）打折
    function entryFreqScore(entry) {
      let fr = 0;
      for (const f of entry[0]) { const n = formFreq(f); if (n > fr) fr = n; }
      for (const f of entry[1]) { const n = formFreq(f); if (n > fr) fr = n; }
      return 7 * Math.log2(1 + fr) * (entry[2] ? 1 : 0.4);
    }

    // 內建日常高頻詞白名單（完全符合搜尋讀音時給予最高排序加權，優先於一般單漢字 common 詞）
    const SUPER_COMMON_WORDS = new Set([
      // 時間與日期（解決 きょう -> 京/卿 等問題）
      '今日', '明日', '昨日', '一昨日', '明後日', '今年', '来年', '去年',
      '毎日', '毎週', '毎月', '毎年', '今', '朝', '昼', '夜', '夕方', '時間', '休み', '週末',
      // 人物與代名詞
      '私', '僕', '彼', '彼女', '人', '友達', '家族', '先生', '学生', '子供', '大人',
      // 最常被單漢字新聞詞壓過的同音日常詞
      '雨', '飴', '紙', '髪', '神', '橋', '箸', '木', '気', '花', '鼻',
      '耳', '目', '手', '足', '口', '心', '声', '音', '歌', '絵', '字', '本',
      '空', '海', '山', '川', '雪', '風', '雲', '星', '月', '日', '火', '水', '天気',
      // 生活、旅遊與基礎動詞形容詞
      '日本', '日本語', '駅', '電車', '車', '飛行機', 'ホテル', '温泉', 'お風呂',
      'ご飯', 'パン', 'お茶', 'お酒', '肉', '魚', '野菜', '果物', '猫', '犬',
      '好き', '嫌い', '楽しい', '嬉しい', '悲しい', '美味しい', '寒い', '暑い', '新しい', '古い',
      '食べる', '飲む', '行く', '来る', '帰る', '見る', '聞く', '話す', '読む', '書く', '買う', '寝る', '起きる', 'する'
    ]);

    function isSuperCommonEntry(entry) {
      for (const w of entry[0]) if (SUPER_COMMON_WORDS.has(w)) return true;
      for (const r of entry[1]) if (SUPER_COMMON_WORDS.has(r)) return true;
      return false;
    }

    // 查詢字是否精確命中詞條的表記或讀音（不再依讀音順序先後扣分）
    function matchIndex(entry, variants) {
      for (const v of variants) { const i = entry[0].indexOf(v); if (i >= 0) return i; }
      for (const v of variants) { const i = entry[1].indexOf(v); if (i >= 0) return i; }
      return -1;
    }

    // 同音／同形精確命中排序：
    // 1. 取消「字數越短越優先」與「主讀音順序（idx > 0）扣分」
    // 2. 完全符合搜尋讀音且在 SUPER_COMMON_WORDS 名單內者給予最高排序加權
    function rankByCoreScore(entries, variants, topK = 60) {
      const info = entries.map(e => {
        const matched = matchIndex(e, variants) >= 0;
        const superBonus = (matched && isSuperCommonEntry(e)) ? 500 : 0;
        return { e, s: coreBase(e) + superBonus };
      });
      info.sort((a, b) => b.s - a.s);
      const head = info.slice(0, topK);
      head.forEach(x => { x.s += entryFreqScore(x.e); });
      head.sort((a, b) => b.s - a.s);
      return head.concat(info.slice(topK)).map(x => x.e);
    }

    // ===== 萬用字元搜尋：? ＝ 任意 1 個字元；* ＝ 0 個或多個字元；同時比對漢字表記與假名讀音 =====
    const RE_WILD = /[?？*＊]/;

    function wildcardRegexes(pattern) {
      const pats = new Set([pattern]);
      if (/[\u3041-\u3096]/.test(pattern)) pats.add(toKatakana(pattern));   // 平假名也比對片假名詞
      if (/[\u30A1-\u30F6]/.test(pattern)) pats.add(toHiragana(pattern));
      return [...pats].map(p => {
        let src = '';
        for (const ch of p) {
          src += ch === '?' ? '.' : ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        }
        return new RegExp('^' + src + '$', 'su');
      });
    }

    function searchWildcard(rawQuery) {
      const pattern = rawQuery.replace(/？/g, '?').replace(/＊/g, '*').replace(/\*{2,}/g, '*');
      const base = { mode: 'wild', badge: '萬用字元搜尋' };
      const literal = pattern.replace(/[?*]/g, '');
      if (!literal) {
        return { ...base, results: [], note: '請在 ? 或 * 之外至少輸入一個字，例如「す?き」「スキー*」「日?」' };
      }
      const regexes = wildcardRegexes(pattern);
      const minLen = [...literal].length + (pattern.match(/\?/g) || []).length;   // 至少幾個字元
      const maxLen = pattern.includes('*') ? Infinity : minLen * 2;               // 沒有 * 時的長度上限（UTF-16）
      const hits = [];
      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        let len = Infinity;                                                      // 命中的表記／讀音中最短的長度
        let idx = Infinity;                                                      // 命中的是第幾個表記／讀音（0 ＝ 第一個）
        for (let part = 0; part < 2; part++) {
          const forms = entry[part];
          for (let k = 0; k < forms.length; k++) {
            const f = forms[k];
            if (f.length < minLen || f.length > maxLen) continue;
            for (let r = 0; r < regexes.length; r++) {
              if (regexes[r].test(f)) {
                if (f.length < len) len = f.length;
                if (k < idx) idx = k;
                break;
              }
            }
          }
        }
        if (len !== Infinity) hits.push({ entry, len, idx, s: coreBase(entry) + (idx === 0 ? 10 : -12) });
      }
      // 常用詞優先 → 較短的詞優先 → 同長度再依常用度分數
      const order = (a, b) => (b.entry[2] - a.entry[2]) || (a.len - b.len) || (b.s - a.s);
      hits.sort(order);
      // 同長度的詞很多時，前段候選再加上例句語料次數細排（今日 ＞ 境〔さかい／きょう〕）
      const head = hits.slice(0, 150);
      head.forEach(h => { h.s += entryFreqScore(h.entry) * (h.idx > 0 ? 0.35 : 1); });
      head.sort(order);
      const results = head.slice(0, 50).map(h => h.entry);
      const note = hits.length
        ? `萬用字元「${pattern}」（? 任意 1 字、* 任意長度）：共 ${hits.length} 筆，優先列出常用與較短的詞${hits.length > 50 ? '，僅顯示前 50 筆' : ''}`
        : `萬用字元「${pattern}」沒有符合的日文詞條（比對範圍：漢字表記與假名讀音）`;
      return { ...base, results, note };
    }

    // ===== 日文（假名／漢字）搜尋：含平片假名互通與活用形還原 =====
    function searchJapaneseText(q, meta) {
      meta = meta || {};
      const variants = kanaVariants(q);
      const v0 = variants[0];
      const v1 = variants[1];
      const infMap = buildInflectionMap(q);
      const exact = [], prefix = [], partial = [], deHits = [];

      const hasForm = (arr, v) => arr.includes(v);
      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const kanjis = entry[0];
        const kanas = entry[1];
        if (hasForm(kanjis, v0) || hasForm(kanas, v0) || (v1 && (hasForm(kanjis, v1) || hasForm(kanas, v1)))) {
          exact.push(entry);
          continue;
        }
        if (infMap) {
          const hit = matchInflection(entry, infMap);
          if (hit) { deHits.push(hit); continue; }
        }
        let isPrefix = false;
        for (let k = 0; k < kanjis.length && !isPrefix; k++) isPrefix = kanjis[k].startsWith(v0) || (v1 && kanjis[k].startsWith(v1));
        for (let k = 0; k < kanas.length && !isPrefix; k++) isPrefix = kanas[k].startsWith(v0) || (v1 && kanas[k].startsWith(v1));
        if (isPrefix) { prefix.push(entry); continue; }
        if (partial.length < 40) {
          let isPart = false;
          for (let k = 0; k < kanjis.length && !isPart; k++) isPart = kanjis[k].includes(v0) || (v1 && kanjis[k].includes(v1));
          for (let k = 0; k < kanas.length && !isPart; k++) isPart = kanas[k].includes(v0) || (v1 && kanas[k].includes(v1));
          if (isPart) partial.push(entry);
        }
      }
      // 精確命中：以常用度分數排序（不再只看字數或原始編號），日常高頻詞排第一
      const exactRanked = rankByCoreScore(exact, variants);
      const byCommonCore = (a, b) => (b[2] - a[2]) || (coreBase(b) - coreBase(a));
      prefix.sort(byCommonCore);
      partial.sort((a, b) => (b[2] - a[2]) || (coreBase(b) - coreBase(a)));
      deHits.sort((a, b) => (b.entry[2] - a.entry[2]) || (a.path.length - b.path.length) || (b.entry[3].length - a.entry[3].length));
      let deTop = deHits.slice(0, 20);
      // 全平假名時同音詞很多：優先只留常用詞（至少保留 3 筆），避免雜訊
      if (/^[\u3041-\u3096ー]+$/.test(q) && deTop.length > 4) {
        const common = deTop.filter(h => h.entry[2]);
        deTop = (common.length >= 3 ? common : deTop.slice(0, 3)).slice(0, 8);
      }

      const inflections = new Map();
      deTop.forEach(h => inflections.set(h.entry, { surface: q, base: h.base, path: h.path }));

      const results = [
        ...exactRanked.slice(0, 50),
        ...deTop.map(h => h.entry),
        ...prefix,
        ...partial
      ].slice(0, 60);

      const bases = [...new Set(deTop.map(h => h.base))].slice(0, 3);
      let note = meta.romaji ? `羅馬拼音「${meta.romaji}」→ ${q}` : `直接比對日文讀音與表記「${q}」`;
      let badge = meta.romaji ? '羅馬拼音 → 日文' : '日文假名檢索';
      if (deTop.length > 0) {
        note += `；偵測到變化形，還原為 ${bases.join('、')}`;
        if (exact.length === 0) badge = '活用形還原';
      }
      return { mode: 'jp', badge, note, results, inflections, exactCount: exact.length };
    }

    // 英文搜尋：釋義完全等於輸入字的詞優先（eat → 食べる），再依詞性順序、常用度排序
    function searchEnglish(q, qLower) {
      const escaped = qLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRegex = new RegExp(`\\b${escaped}\\b`);
      const toForm = `to ${qLower}`;
      const scored = [];
      let strong = 0;

      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const senses = entry[3];
        let best = 0;
        let strongEntry = false;
        for (let j = 0; j < senses.length; j++) {
          const glosses = senses[j].g;
          for (let k = 0; k < glosses.length; k++) {
            const gLow = glosses[k].toLowerCase();
            if (!gLow.includes(qLower)) continue;
            const gClean = gLow.replace(/\([^)]*\)/g, '').trim();
            let sc;
            if (gClean === qLower || gClean === toForm) {
              sc = 100;                                   // 釋義完全相同
            } else if (gClean.startsWith(qLower + ' ') || gClean.startsWith(toForm + ' ')) {
              sc = 60;                                    // eat out、to eat up 之類片語
            } else if (wordRegex.test(gClean)) {
              sc = 30;                                    // 句中出現該單字
            } else {
              sc = 8;                                     // 只是字串包含
            }
            if (sc >= 30) strongEntry = true;
            if (sc >= 60 && gClean !== gLow.trim()) sc -= 15; // 帶括號補充（如 go (board game)）略降
            sc -= Math.min(j, 6) * 4 + Math.min(k, 4);    // 越前面的釋義越重要
            sc -= Math.min(glosses.length - 1, 4);        // 該義項釋義越精簡越準
            if (sc > best) best = sc;
          }
        }
        if (strongEntry) strong++;
        if (best > 0) {
          if (entry[2]) best += 25;                       // 常用詞加分
          best -= Math.min(senses.length, 10) * 0.5;      // 義項太多的多義詞略降
          scored.push([best, entry]);
        }
      }

      scored.sort((x, y) => y[0] - x[0]);
      return {
        mode: 'en',
        badge: '英文 → 日文與發音',
        note: `搜尋英文釋義包含「${q}」的日文單字（完全相同的釋義排最前面）`,
        results: scored.slice(0, 50).map(x => x[1]),
        strong
      };
    }

    // ===== 純本地斷詞引擎（最大正向匹配 ＋ 變化形反查 ＋ 常見助詞清單）=====
    const COMMON_PARTICLES = new Set([
      'は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'の',
      'から', 'まで', 'より', 'ね', 'よ', 'か'
    ]);

    const PARTICLE_GRAMMAR = {
      'は': '主題／對比助詞（提示主題）',
      'が': '主格助詞（提示主語／對象）',
      'を': '賓格助詞（提示動作對象）',
      'に': '格助詞（時間／地點／方向／對象）',
      'で': '格助詞（動作場所／手段／原因）',
      'と': '格助詞（並列「和」／共同／引用）',
      'も': '係助詞（也／連…都）',
      'へ': '格助詞（移動方向「往／向」）',
      'の': '格助詞（所屬「的」／同位／名詞化）',
      'から': '格助詞（起點「從…」／原因「因為…」）',
      'まで': '副助詞（終點「到…為止」）',
      'より': '格助詞（比較基準「比…」／起點）',
      'ね': '終助詞（確認／徵求認同「…吧／…呢」）',
      'よ': '終助詞（告知／強調提醒「…喔／…啊」）',
      'か': '終助詞・副助詞（疑問「…嗎」／不確定）'
    };

    const COPULA_TOKENS = new Set([
      'です', 'でした', 'でしょう', 'でしょ', 'だろう', 'だろ',
      'だ', 'だった', 'じゃない', 'じゃなかった',
      'ではない', 'ではなかった', 'ではありません', 'じゃありません'
    ]);

    // 含助詞字元但本身為單一高頻詞的白名單（避免斷詞誤切）
    const SEG_WHOLE_WORDS = new Set([
      ...SUPER_COMMON_WORDS,
      'こんにちは', 'こんにちわ', 'こんばんは', 'こんばんわ', 'さようなら',
      'ありがとう', 'ありがとうございます', 'すみません', 'おはよう', 'おはようございます',
      'いただきます', 'ごちそうさま', 'おねがい', 'お願い', 'おねがいします', 'お願いします',
      'だいじょうぶ', '大丈夫', 'はじめまして', 'よろしく', 'よろしくお願いします',
      'おやすみ', 'おやすみなさい', 'いってきます', 'いってらっしゃい', 'ただいま',
      'おかえり', 'おかえりなさい', 'おめでとう', 'ごめんなさい', 'しつれいします', '失礼します',
      'おつかれさま', 'お疲れ様', 'いつも', 'とても', 'とっても', 'しかし', 'だから',
      'けれど', 'けれども', 'そして', 'それで', 'それから', 'それに', 'それでも', 'それでは',
      'では', 'じゃあ', 'やっぱり', 'やはり', 'もちろん', 'たぶん', '多分', 'きっと',
      'ぜひ', '是非', 'なかなか', 'だんだん', 'ますます', 'そろそろ', 'ようやく', 'やっと',
      'とうとう', 'ついに', 'いきなり', 'とつぜん', '突然', 'じつは', '実は', 'ほんとう', '本当',
      'ほんとうに', '本当に', 'たしかに', '確かに', 'とくに', '特に', 'べつに', '別に',
      'きゅうに', '急に', 'いっしょに', '一緒に', 'さきに', '先に', 'あとで', '後に',
      'まえに', '前に', 'つぎに', '次に', 'さいごに', '最後に', 'さいしょに', '最初に',
      'しずかに', '静かに', 'げんきに', '元気に', 'きれいに', '綺麗に', 'じょうずに', '上手に',
      'たいせつに', '大切に', 'じゆうに', '自由に', 'ふつうに', '普通に', 'かんたんに', '簡単に',
      'ぶじに', '無事に', 'ていねいに', '丁寧に', 'わたし', '私', 'あなた', 'かれ', '彼',
      'かのじょ', '彼女', 'わたしたち', '私たち', 'みんな', '皆', 'みなさん', '皆さん',
      'だれ', '誰', 'なに', '何', 'どこ', '何処', 'いつ', '何時', 'なぜ', '何故', 'どうして',
      'どのように', 'どの', 'この', 'その', 'あの', 'これ', 'それ', 'あれ', 'どれ',
      'ここ', 'そこ', 'あそこ', 'こちら', 'そちら', 'あちら', 'どちら',
      'きょう', '今日', 'あした', '明日', 'きのう', '昨日', 'おととい', 'あさって',
      'いま', '今', 'まいにち', '毎日', 'まいあさ', '毎朝', 'まいばん', '毎晩',
      'まいしゅう', '毎週', 'まいつき', '毎月', 'まいとし', '毎年',
      'ともだち', '友達', 'かぞく', '家族', 'かぜ', '風', 'かお', '顔', 'からだ', '体',
      'おかね', 'お金', 'かね', '金', 'かみ', '紙', '髪', 'かわ', '川', '皮',
      'はな', '花', '鼻', 'きもち', '気持ち', 'こども', '子供', 'しごと', '仕事',
      'のむ', '飲む', 'いく', '行く', 'みる', '見る', 'きる', '着る', '切る', 'しる', '知る',
      'かく', '書く', 'きく', '聞く', 'あるく', '歩く', 'はしる', '走る', 'あそぶ', '遊ぶ',
      'やすむ', '休む', 'はたらく', '働く', 'つかう', '使う', 'つくる', '作る', 'もつ', '持つ',
      'とる', '取る', 'おく', '置く', 'あける', '開ける', 'しめる', '閉める', 'はいる', '入る',
      'でる', '出る', 'のる', '乗る', 'おりる', '降りる', 'ねる', '寝る', 'おきる', '起きる',
      'わすれる', '忘れる', 'おぼえる', '覚える', 'おしえる', '教える', 'てつだう', '手伝う',
      'からい', '辛い', 'あまい', '甘い', 'たかい', '高い', 'やすい', '安い', 'ながい', '長い',
      'みじかい', '短い', 'ひろい', '広い', 'せまい', '狭い', 'あつい', '暑い', '熱い',
      'さむい', '寒い', 'つめたい', '冷たい', 'あたたかい', '暖かい', '温かい', 'すずしい', '涼しい',
      'おいしい', '美味しい', 'たのしい', '楽しい', 'うれしい', '嬉しい', 'かなしい', '悲しい',
      'いそがしい', '忙しい', 'かわいい', '可愛い', 'かっこいい', 'すごい', '凄い',
      'かえる', '帰る', '変える', 'でんわ', '電話', 'てがみ', '手紙', 'しゃしん', '写真',
      'りょこう', '旅行', 'おんせん', '温泉', 'しんかんせん', '新幹線', 'ちかてつ', '地下鉄',
      'びょういん', '病院', 'ぎんこう', '銀行', 'としょかん', '図書館', 'こうえん', '公園',
      'なんとかなる', '何とかなる', 'なんとかする', '何とかする', 'どうにかなる', 'どうにかする',
      'しょうがない', '仕様がない', 'しかたがない', '仕方がない', 'しかたない', '仕方ない',
      'かもしれない', 'かもしれません', 'にちがいない', 'に違いない', 'にきまっている', 'に決まっている',
      'おかげさまで', 'お蔭様で', 'おせわになります', 'お世話になります', 'おじゃまします', 'お邪魔します',
      'きをつける', '気をつける', 'きにする', '気にする', 'きにいる', '気に入る'
    ]);

    const RE_SEG_PUNCT = /[\s　、-〄〈-〠〰〽・！-／：-＠［-｀｛-･!"#$%&'()*+,\-./:;<=>?@[\\]^_`{|}~…‥]/;
    const RE_HAS_PARTICLE = /(?:から|まで|より|[はがをにでともへのねよか])/;
    const RE_ENDS_PARTICLE = /(?:から|まで|より|[はがをにでともへのねよか])$/;

    // 極少數在 common=1 中仍應優先拆成「代名詞／名詞＋助詞」的短語
    const FORCE_SPLIT_PHRASES = new Set(['かれは', 'かのじょは', 'わたしは', 'あなたは', 'これは', 'それは', 'あれは']);

    let segIndex = null;

    function getSegIndex() {
      if (segIndex) return segIndex;
      const commonForms = new Set([...SEG_WHOLE_WORDS, ...COPULA_TOKENS]);
      const rareForms = new Set();
      const commonKanjiExact = new Set();

      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const isCommon = entry[2] === 1;
        for (const k of entry[0]) {
          if (isCommon) {
            commonForms.add(k);
            commonKanjiExact.add(k);
          } else {
            rareForms.add(k);
          }
        }
        for (const r of entry[1]) {
          const isHiraOnly = /^[\u3041-\u3096ー]+$/.test(r);
          if (isCommon) {
            // 保留 common=1 的兩字以上平假名詞（如 さかな、ねこ、あかい），僅排除極少數需拆分的短語
            if ((!isHiraOnly || [...r].length >= 2) && !FORCE_SPLIT_PHRASES.has(r)) {
              commonForms.add(r);
            }
          } else {
            // common=0 的冷門同音純平假名若含助詞（如 きょうは＝教派），不納入正向匹配整詞
            if (!isHiraOnly) {
              rareForms.add(r);
            } else if ([...r].length >= 2 && !RE_HAS_PARTICLE.test(r)) {
              rareForms.add(r);
            }
          }
        }
      }
      segIndex = { commonForms, rareForms, commonKanjiExact };
      return segIndex;
    }

    // O(1) 檢查是否為單一常用動詞／形容詞的活用形（如 のみます、さむかった）
    function isSingleCommonInflection(q, idx) {
      const infMap = buildInflectionMap(q);
      if (!infMap) return false;
      for (const base of infMap.keys()) {
        if (idx.commonForms.has(base)) return true;
      }
      return false;
    }

    // 檢查整串輸入能否由日文詞庫詞彙無未收錄片段（OOV）完整覆蓋（用於區分長串日文漢字與純中文句子）
    function isFullyCoveredByJpLexicon(q, idx) {
      const chars = [...q];
      let i = 0;
      while (i < chars.length) {
        if (RE_SEG_PUNCT.test(chars[i])) { i++; continue; }
        let matchedLen = 0;
        const maxLen = Math.min(12, chars.length - i);
        for (let len = maxLen; len >= 1; len--) {
          const sub = chars.slice(i, i + len).join('');
          if (RE_SEG_PUNCT.test(sub)) continue;
          if (len === 1) {
            if (COMMON_PARTICLES.has(sub) || idx.commonKanjiExact.has(sub)) { matchedLen = 1; break; }
            continue;
          }
          if (COMMON_PARTICLES.has(sub) || idx.commonForms.has(sub) || matchesKnownInflection(sub, idx)) {
            matchedLen = len;
            break;
          }
        }
        if (!matchedLen) return false;
        i += matchedLen;
      }
      return true;
    }

    function shouldTriggerSegmentation(q) {
      if (!q || isNumericQuery(q) || RE_WILD.test(q) || isAsciiEnglish(q)) return false;
      if (!hasKana(q) && !hasHanzi(q)) return false;

      const idx = getSegIndex();
      const len = [...q].length;
      const hasPunct = RE_SEG_PUNCT.test(q);
      const hasOrEndsParticle = RE_HAS_PARTICLE.test(q) || RE_ENDS_PARTICLE.test(q);

      // 純漢字（無假名）且超過 6 字：僅在整串能被日文詞庫完整覆蓋時才走日文斷詞，避免誤切純中文長句
      if (!hasKana(q) && hasHanzi(q) && len > 6 && !hasPunct) {
        return isFullyCoveredByJpLexicon(q, idx);
      }

      if (len <= 6 && !hasPunct) {
        if (!hasOrEndsParticle) return false;
        const hira = toHiragana(q);
        if (FORCE_SPLIT_PHRASES.has(q) || FORCE_SPLIT_PHRASES.has(hira)) return true;
        if (SEG_WHOLE_WORDS.has(q) || SEG_WHOLE_WORDS.has(hira)) return false;
        if (COPULA_TOKENS.has(q) || COPULA_TOKENS.has(hira)) return false;
        if (idx.commonForms.has(q) || idx.commonForms.has(hira)) return false;
        if (isSingleCommonInflection(q, idx)) return false;
        if (hasHanzi(q) && idx.commonKanjiExact.has(q)) return false;
        return true;
      }

      return len > 6 || hasPunct || hasOrEndsParticle;
    }

    function charScriptType(ch) {
      if (RE_SEG_PUNCT.test(ch)) return 'punct';
      if (RE_KANJI.test(ch) || /[々〆ヶ]/.test(ch)) return 'kanji';
      if (/[぀-ゟ]/.test(ch)) return 'hiragana';
      if (/[゠-ヿー]/.test(ch)) return 'katakana';
      if (/[A-Za-z0-9]/.test(ch)) return 'latin';
      return 'other';
    }

    const SEG_STEM_ENDINGS = {
      'い': 'う', 'き': 'く', 'ぎ': 'ぐ', 'し': 'す', 'ち': 'つ',
      'に': 'ぬ', 'び': 'ぶ', 'み': 'む', 'り': 'る'
    };

    function matchesKnownInflection(sub, idx) {
      if ([...sub].length < 2) return false;
      const infMap = buildInflectionMap(sub);
      if (infMap) {
        for (const k of infMap.keys()) {
          if (idx.commonForms.has(k) || idx.rareForms.has(k)) return true;
        }
      }
      const stemV1 = sub + 'る';
      if (idx.commonForms.has(stemV1)) return true;
      const last = sub.slice(-1);
      if (SEG_STEM_ENDINGS[last]) {
        const stemV5 = sub.slice(0, -1) + SEG_STEM_ENDINGS[last];
        if (idx.commonForms.has(stemV5)) return true;
      }
      return false;
    }

    function canMatchLexicalAt(chars, pos, idx) {
      const maxLen = Math.min(12, chars.length - pos);
      for (let len = maxLen; len >= 1; len--) {
        const sub = chars.slice(pos, pos + len).join('');
        if (RE_SEG_PUNCT.test(sub)) continue;
        if (len === 1) {
          if (COMMON_PARTICLES.has(sub)) return true;
          if (RE_KANJI.test(sub) && (idx.commonForms.has(sub) || idx.rareForms.has(sub))) return true;
          continue;
        }
        if (COMMON_PARTICLES.has(sub) || idx.commonForms.has(sub) || idx.rareForms.has(sub)) return true;
        if (matchesKnownInflection(sub, idx)) return true;
      }
      return false;
    }

    // 純本地斷詞：最大正向匹配 ＋ 變化形反查 ＋ 常見助詞清單（過濾純標點）
    function segmentJapaneseText(rawText) {
      const idx = getSegIndex();
      const chars = [...rawText];
      const tokens = [];
      let i = 0;

      while (i < chars.length) {
        if (RE_SEG_PUNCT.test(chars[i])) {
          i++;
          continue;
        }

        let spanEnd = i;
        while (spanEnd < chars.length && !RE_SEG_PUNCT.test(chars[spanEnd])) spanEnd++;

        let matched = null;
        const maxLen = Math.min(12, spanEnd - i);
        for (let len = maxLen; len >= 1; len--) {
          const sub = chars.slice(i, i + len).join('');
          if (len === 1) {
            if (COMMON_PARTICLES.has(sub)) {
              matched = { text: sub, isParticle: true, len: 1 };
              break;
            }
            if (RE_KANJI.test(sub) && (idx.commonForms.has(sub) || idx.rareForms.has(sub))) {
              matched = { text: sub, isParticle: false, len: 1 };
              break;
            }
            continue;
          }

          if (COMMON_PARTICLES.has(sub)) {
            matched = { text: sub, isParticle: true, len };
            break;
          }
          if (idx.commonForms.has(sub) || idx.rareForms.has(sub)) {
            matched = { text: sub, isParticle: false, len };
            break;
          }
          if (matchesKnownInflection(sub, idx)) {
            matched = { text: sub, isParticle: false, len };
            break;
          }
        }

        if (matched) {
          tokens.push({ text: matched.text, isParticle: matched.isParticle });
          i += matched.len;
          continue;
        }

        // 未收錄片段依字元類型切分
        const baseType = charScriptType(chars[i]);
        let j = i + 1;
        while (j < spanEnd) {
          const nextType = charScriptType(chars[j]);
          const sameGroup = nextType === baseType ||
            (chars[j] === 'ー' && (baseType === 'hiragana' || baseType === 'katakana'));
          if (!sameGroup) break;
          if (canMatchLexicalAt(chars, j, idx)) break;
          j++;
        }
        tokens.push({ text: chars.slice(i, j).join(''), isParticle: false });
        i = j;
      }

      return tokens;
    }

    // 針對單一斷詞精準檢索（只取精確命中與活用形還原，不混入前綴模糊搜尋）
    function searchSegmentToken(tokenObj) {
      const q = tokenObj.text;
      const variants = kanaVariants(q);
      const v0 = variants[0];
      const v1 = variants[1];
      const infMap = buildInflectionMap(q);
      const exact = [];
      const deHits = [];

      const hasForm = (arr, v) => arr.includes(v);
      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const kanjis = entry[0];
        const kanas = entry[1];
        if (hasForm(kanjis, v0) || hasForm(kanas, v0) || (v1 && (hasForm(kanjis, v1) || hasForm(kanas, v1)))) {
          exact.push(entry);
          continue;
        }
        if (infMap) {
          const hit = matchInflection(entry, infMap);
          if (hit) deHits.push(hit);
        }
      }

      if (exact.length === 0 && deHits.length === 0 && [...q].length >= 2) {
        const stemCands = [q + 'る'];
        const last = q.slice(-1);
        if (SEG_STEM_ENDINGS[last]) stemCands.push(q.slice(0, -1) + SEG_STEM_ENDINGS[last]);
        for (let i = 0; i < dictData.length; i++) {
          const entry = dictData[i];
          if (!entry[2]) continue;
          const forms = entry[0].concat(entry[1]);
          if (stemCands.some(c => forms.includes(c))) {
            deHits.push({ entry, path: ['連用形語幹'], base: forms[0] });
          }
        }
      }

      let exactRanked = rankByCoreScore(exact, variants);
      if (tokenObj.isParticle && exactRanked.length > 1) {
        const isPrt = e => e[3].some(s => (s.p || []).includes('prt'));
        exactRanked = [
          ...exactRanked.filter(isPrt),
          ...exactRanked.filter(e => !isPrt(e))
        ];
      }

      deHits.sort((a, b) => (b.entry[2] - a.entry[2]) || (a.path.length - b.path.length) || (b.entry[3].length - a.entry[3].length));
      const deTop = deHits.slice(0, 12);
      const inflections = new Map();
      deTop.forEach(h => inflections.set(h.entry, { surface: q, base: h.base, path: h.path }));

      const results = [
        ...exactRanked.slice(0, 30),
        ...deTop.map(h => h.entry)
      ].slice(0, 30);

      let note = `斷詞「${q}」的所有相符詞條`;
      if (tokenObj.isParticle) note += '（助詞）';
      else if (deTop.length > 0 && exactRanked.length === 0) {
        const bases = [...new Set(deTop.map(h => h.base))].slice(0, 2);
        note += `（活用形還原：${bases.join('、')}）`;
      }

      return {
        mode: 'jp',
        badge: '斷詞模式',
        note,
        results,
        inflections,
        exactCount: exactRanked.length
      };
    }

    // 檢查整串輸入是否在詞庫中有完全匹配的冷門同音詞（如 きょうは ➔ 教派）
    function findExactFullMatches(q) {
      const variants = kanaVariants(q);
      const v0 = variants[0];
      const v1 = variants[1];
      const exact = [];
      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const kanjis = entry[0];
        const kanas = entry[1];
        if (kanjis.includes(v0) || kanas.includes(v0) || (v1 && (kanjis.includes(v1) || kanas.includes(v1)))) {
          exact.push(entry);
        }
      }
      return rankByCoreScore(exact, variants);
    }

    // 單一假名且非常見助詞時，避免隨便配對冷門古語漢字（如「る」配成律令制「流刑、流放」）
    function shouldSuppressSingleKanaEntry(tokText, isParticle, entry) {
      if (isParticle || !entry) return false;
      const chars = [...String(tokText || '')];
      if (chars.length !== 1 || !/^[\u3040-\u309F\u30A0-\u30FFー]$/.test(chars[0])) return false;
      if (COMMON_PARTICLES.has(toHiragana(chars[0]))) return false;
      const senses = entry[3] || [];
      const allTags = senses.flatMap(sn => sn.p || []);
      const isArchaicOnly = allTags.length > 0 && allTags.every(tag => tag === 'arch' || tag === 'obs' || tag === 'dated' || tag === 'hist');
      return !entry[2] || isArchaicOnly;
    }

    function buildSegmentedOverview(q, tokens) {
      const enriched = tokens.map(tok => {
        const res = searchSegmentToken(tok);
        let bestEntry = res.results[0] || null;
        if (bestEntry && shouldSuppressSingleKanaEntry(tok.text, tok.isParticle, bestEntry)) {
          const alt = res.results.find(e => !shouldSuppressSingleKanaEntry(tok.text, tok.isParticle, e));
          bestEntry = alt || null;
        }
        const inflection = bestEntry && res.inflections ? res.inflections.get(bestEntry) || null : null;
        return { ...tok, tokenRes: res, bestEntry, inflection };
      });
      const exactFullMatches = tokens.length >= 2 ? findExactFullMatches(q) : [];
      return {
        mode: 'jp',
        isSegmented: true,
        segViewMode: 'overview',
        activeSegmentIndex: -1,
        rawQuery: q,
        tokens: enriched,
        exactFullMatches,
        results: enriched.map(t => t.bestEntry).filter(Boolean)
      };
    }

    function primaryPosText(entry, isParticle) {
      if (isParticle) return '助詞';
      const senses = entry[3] || [];
      for (let i = 0; i < senses.length; i++) {
        const p = senses[i].p;
        if (p && p.length > 0) return posLabel(p[0]);
      }
      return '';
    }

    function primaryMeaningText(entry, tokenText, isParticle) {
      if (isParticle && PARTICLE_GRAMMAR[tokenText]) {
        return PARTICLE_GRAMMAR[tokenText];
      }
      const zhs = (entry[4] || []).filter(z => !/[㐀-䶿]/.test(z));
      if (zhs.length > 0) {
        return zhs.slice(0, 3).join('、');
      }
      const senses = entry[3] || [];
      if (senses.length > 0 && senses[0].g && senses[0].g.length > 0) {
        return senses[0].g.slice(0, 2).join('; ');
      }
      return '';
    }

    // ===== AI 整句翻譯 ＋ 語意拆句增強（長句自動觸發 ＋ 手動按鈕切換，無設定時自動退回純本地斷詞）=====
    const aiSegCache = new Map();
    const aiWordZhCache = new Map();
    let aiSegTimer = null;

    function getAiSegmentEndpoint() {
      const ep = (window.YUKIYOSEI_AI_SEGMENT_ENDPOINT || '').trim();
      return ep || '';
    }

    function hasChromeBuiltInAi() {
      return typeof window !== 'undefined' && (
        (window.LanguageModel && typeof window.LanguageModel.create === 'function') ||
        (window.ai && window.ai.languageModel && typeof window.ai.languageModel.create === 'function')
      );
    }

    function isAiSegmentAvailable() {
      return Boolean(getAiSegmentEndpoint() || hasChromeBuiltInAi());
    }

    function findBestLocalEntryForAiToken(surface, baseForm, reading, isParticle) {
      if (isParticle) {
        const res = searchSegmentToken({ text: baseForm || surface, isParticle: true });
        return res.results[0] || null;
      }
      const candidates = [baseForm, surface].filter(Boolean);
      for (const cand of candidates) {
        const res = searchSegmentToken({ text: cand, isParticle: false });
        let best = res.results[0] || null;
        if (best && shouldSuppressSingleKanaEntry(cand, false, best)) {
          best = res.results.find(e => !shouldSuppressSingleKanaEntry(cand, false, e)) || null;
        }
        if (best) {
          if (reading) {
            const hiraTarget = toHiragana(reading);
            const exactReadingHit = res.results.find(e =>
              !shouldSuppressSingleKanaEntry(cand, false, e) &&
              (e[1] || []).some(r => toHiragana(r) === hiraTarget)
            );
            if (exactReadingHit) return exactReadingHit;
          }
          return best;
        }
      }
      return null;
    }

    async function requestAiTranslate(text, from, to) {
      const cacheKey = `${from}|${to}|${text}`;
      if (aiWordZhCache.has(cacheKey)) return aiWordZhCache.get(cacheKey);
      const ep = getAiSegmentEndpoint();
      if (!ep) throw new Error('未設定 AI 翻譯端點');
      const resp = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'translate', text, from, to })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const translated = String(data?.translated || '').trim();
      if (!translated) throw new Error('AI 未回傳譯文');
      const res = {
        text: translated,
        reading: String(data?.reading || '').trim(),
        engine: 'Gemini AI'
      };
      aiWordZhCache.set(cacheKey, res);
      return res;
    }

    async function requestAiSegmentation(sentence) {
      const ep = getAiSegmentEndpoint();
      if (ep) {
        const resp = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'segment', text: sentence })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const tokens = Array.isArray(data) ? data : (data && Array.isArray(data.tokens) ? data.tokens : null);
        if (!tokens) throw new Error('Invalid AI payload');
        const translation = (data && !Array.isArray(data) && data.translation)
          ? {
              zh: String(data.translation.zh || '').trim(),
              reading: String(data.translation.reading || '').trim()
            }
          : null;
        return { translation, tokens };
      }

      if (hasChromeBuiltInAi()) {
        const factory = window.LanguageModel || (window.ai && window.ai.languageModel);
        const session = await factory.create({
          systemPrompt: '你是日語文法與詞彙分析助手。請將輸入的日文句子提供整句自然繁體中文翻譯與語意斷詞，僅回傳 JSON 物件（不要 Markdown 標記）：{"translation":{"zh":"整句繁體中文翻譯","reading":"平假名讀音"},"tokens":[{"surface":"原句片段","base":"辭書原型","reading":"平假名讀音","pos":"詞性","zh":"貼合此句上下文的簡潔繁體中文釋義","isParticle":false}]}'
        });
        try {
          const raw = await session.prompt(sentence);
          const cleaned = String(raw || '').replace(/^```(?:json)?|```$/gm, '').trim();
          const parsed = JSON.parse(cleaned);
          const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.tokens);
          if (!Array.isArray(arr)) throw new Error('Invalid local AI JSON');
          const translation = (parsed && !Array.isArray(parsed) && parsed.translation)
            ? {
                zh: String(parsed.translation.zh || '').trim(),
                reading: String(parsed.translation.reading || '').trim()
              }
            : null;
          return { translation, tokens: arr };
        } finally {
          if (session && typeof session.destroy === 'function') session.destroy();
        }
      }

      throw new Error('未設定 AI 拆句端點');
    }

    async function triggerAiSegmentation(out, token, isManual = false) {
      if (!out || !out.isSegmented || !out.rawQuery) return;
      const q = out.rawQuery.trim();
      if (!q) return;

      if (!isAiSegmentAvailable()) {
        if (isManual) {
          alert('尚未設定 AI 拆句端點（請先於 assets/firebase-config.js 填入 Cloudflare Worker 網址，或使用支援內建 AI 的桌面版 Chrome）。');
        }
        return;
      }

      if (aiSegCache.has(q)) {
        applyAiPayloadToOutput(out, aiSegCache.get(q));
        if (currentTab === 'search') renderCurrentView();
        return;
      }

      out.aiSeg = { state: 'loading', error: '' };
      if (currentTab === 'search') renderCurrentView();

      try {
        const { translation, tokens: rawTokens } = await requestAiSegmentation(q);
        if (token !== searchToken || currentSearchOutput !== out) return;
        const normalized = rawTokens
          .filter(t => t && (t.surface || t.base))
          .map(t => {
            const surface = String(t.surface || t.base || '').trim();
            const base = String(t.base || surface).trim();
            const reading = toHiragana(String(t.reading || '').trim());
            const pos = String(t.pos || '').trim();
            const zh = String(t.zh || '').trim();
            const isParticle = Boolean(t.isParticle || pos === '助詞' || COMMON_PARTICLES.has(base));
            const bestEntry = findBestLocalEntryForAiToken(surface, base, reading, isParticle);
            const lookupText = base || surface;
            const tokenRes = searchSegmentToken({ text: lookupText, isParticle });
            const inflection = (bestEntry && surface && base && surface !== base)
              ? { surface, base, path: [] }
              : null;
            return {
              text: lookupText,
              surfaceText: surface,
              aiReading: reading,
              aiPos: pos,
              aiZh: zh,
              isParticle,
              tokenRes,
              bestEntry,
              inflection
            };
          });

        if (normalized.length === 0) throw new Error('AI 未回傳有效斷詞');
        const payload = { translation, tokens: normalized };
        aiSegCache.set(q, payload);
        applyAiPayloadToOutput(out, payload);
      } catch (err) {
        if (token !== searchToken || currentSearchOutput !== out) return;
        out.aiSeg = { state: 'error', error: (err && err.message) ? err.message : 'AI 拆句失敗' };
      }

      if (currentTab === 'search') renderCurrentView();
    }

    function applyAiPayloadToOutput(out, payload) {
      if (!out.localTokensBackup) out.localTokensBackup = out.tokens;
      const aiTokens = Array.isArray(payload) ? payload : (payload.tokens || []);
      const translation = Array.isArray(payload) ? null : (payload.translation || null);
      out.tokens = aiTokens;
      out.aiTranslation = translation;
      out.results = aiTokens.map(t => t.bestEntry).filter(Boolean);
      out.activeSegmentIndex = -1;
      out.segViewMode = 'overview';
      out.aiSeg = { state: 'done', active: true };
      resultCountEl.textContent = out.tokens.length;
    }

    function toggleAiSegmentation(out) {
      if (!out || !out.isSegmented) return;
      if (out.aiSeg && out.aiSeg.state === 'done' && out.aiSeg.active) {
        if (out.localTokensBackup) {
          out.tokens = out.localTokensBackup;
          out.results = out.tokens.map(t => t.bestEntry).filter(Boolean);
        }
        out.aiSeg.active = false;
        out.activeSegmentIndex = -1;
        out.segViewMode = 'overview';
        resultCountEl.textContent = out.tokens.length;
        renderCurrentView();
        return;
      }
      if (out.aiSeg && out.aiSeg.state === 'done' && !out.aiSeg.active && aiSegCache.has(out.rawQuery.trim())) {
        applyAiPayloadToOutput(out, aiSegCache.get(out.rawQuery.trim()));
        renderCurrentView();
        return;
      }
      triggerAiSegmentation(out, searchToken, true);
    }

    function renderSentenceAiTranslationCard(out) {
      if (!out || !out.isSegmented) return null;
      const aiState = out.aiSeg && out.aiSeg.state;
      const isAiOn = Boolean(aiState === 'done' && out.aiSeg.active);
      const tr = out.aiTranslation;

      if (aiState === 'loading') {
        const box = document.createElement('article');
        box.className = 'word-card translate-card ai-sentence-card is-loading';
        box.innerHTML = `<div class="tr-dir">AI 整句翻譯與語意解析中…</div>`;
        return box;
      }

      if (!isAiOn || !tr || !tr.zh) return null;

      const card = document.createElement('article');
      card.className = 'word-card translate-card ai-sentence-card';
      const readingHtml = tr.reading
        ? `<div class="ai-sentence-reading">${escapeHtml(tr.reading)}</div>`
        : '';
      card.innerHTML = `
        <div class="tr-dir">整句 AI 翻譯 · Gemini</div>
        ${readingHtml}
        <div class="tr-out-row">
          <div class="tr-out ai-sentence-zh">${escapeHtml(tr.zh)}</div>
          <div class="card-actions">
            <button class="icon-btn speak-btn" type="button" title="朗讀日文原句" data-speak="${escapeHtml(out.rawQuery)}">${SPEAKER_SVG}</button>
            <button class="icon-btn copy-btn" type="button" title="複製整句翻譯" data-copy="${escapeHtml(tr.zh)}">${COPY_SVG}</button>
          </div>
        </div>
      `;
      card.querySelector('[data-speak]').addEventListener('click', (e) => {
        speakJapanese(e.currentTarget.getAttribute('data-speak'));
      });
      const aiZhBtn = card.querySelector('[data-ai-word-zh]');
        if (aiZhBtn) {
          aiZhBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const word = aiZhBtn.getAttribute('data-ai-word-zh');
            const hint = aiZhBtn.getAttribute('data-en-hint');
            aiZhBtn.disabled = true;
            aiZhBtn.textContent = '翻譯中…';
            try {
              const res = await translateText(`${word}（${hint}）`, 'ja', 'zh-TW');
              aiWordZhCache.set(`ja-word|zh-TW|${word}`, { text: res.text });
              const parentBox = aiZhBtn.parentElement;
              if (parentBox) {
                parentBox.className = 'zh-meanings zh-compact';
                parentBox.innerHTML = `<span class="zh-pill">${escapeHtml(res.text)}</span><span class="card-gloss-sub">（${escapeHtml(hint)}）</span>`;
              }
            } catch (err) {
              aiZhBtn.disabled = false;
              aiZhBtn.textContent = '補中文';
            }
          });
        }
        card.querySelector('[data-copy]').addEventListener('click', (e) => {
        e.stopPropagation();
        copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
      });
      return card;
    }

    // 渲染「逐詞對照一覽」極簡卡片列表 ＋ 底部同音詞補充連結
    function renderSegmentOverview(out) {
      const wrap = document.createElement('div');
      const list = document.createElement('div');
      list.className = 'word-list seg-overview-list';

      out.tokens.forEach(tok => {
        const entry = tok.bestEntry;
        const card = document.createElement('article');

        if (!entry) {
          const hasAiInfo = Boolean(tok.aiZh || tok.aiPos || tok.aiReading);
          const displayWord = tok.text || tok.surfaceText || '';
          const showAiReading = tok.aiReading && tok.aiReading !== displayWord;
          const surfaceNote = (tok.surfaceText && tok.surfaceText !== displayWord)
            ? `<span class="seg-card-surface">（原句：${escapeHtml(tok.surfaceText)}）</span>`
            : '';
          card.className = 'word-card seg-overview-card' + (tok.isParticle ? ' is-particle' : '');
          card.innerHTML = `
            <div class="seg-card-main">
              ${showAiReading ? `<div class="seg-card-reading">${escapeHtml(tok.aiReading)}</div>` : ''}
              <div class="seg-card-title">
                <span>${escapeHtml(displayWord)}</span>
                <span class="pos-tag">${escapeHtml(hasAiInfo ? (tok.aiPos || 'AI 拆解') : '未收錄')}</span>
                ${surfaceNote}
              </div>
              <div class="seg-card-gloss${tok.isParticle ? ' is-grammar' : ''}">${escapeHtml(hasAiInfo ? (tok.aiZh || 'AI 語意切分') : '詞庫未收錄此片段')}</div>
            </div>
            <div class="card-actions">
              <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(tok.aiReading || displayWord)}">${SPEAKER_SVG}</button>
              <button class="icon-btn copy-btn" type="button" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(displayWord)}">${COPY_SVG}</button>
            </div>
          `;
          card.querySelector('[data-speak]').addEventListener('click', (e) => {
            speakJapanese(e.currentTarget.getAttribute('data-speak'));
          });
          card.querySelector('[data-copy]').addEventListener('click', (e) => {
            e.stopPropagation();
            copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
          });
          list.appendChild(card);
          return;
        }

        const [kanjis, kanas] = entry;
        const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
        const primaryReading = toHiragana(kanas[0] || '');
        const showReading = kanjis.length > 0 && primaryReading && primaryReading !== primaryWord;
        const posText = primaryPosText(entry, tok.isParticle);
        const meaningText = (tok.aiZh && out.aiSeg && out.aiSeg.active) ? tok.aiZh : primaryMeaningText(entry, tok.text, tok.isParticle);
        const fav = isFavorite(entry);
        const inf = tok.inflection;
        const surfaceBadge = inf && inf.surface !== primaryWord
          ? `<span class="seg-card-surface">（原句：${escapeHtml(inf.surface)}）</span>`
          : '';

        card.className = 'word-card seg-overview-card clickable' + (tok.isParticle ? ' is-particle' : '');
        card.innerHTML = `
          <div class="seg-card-main">
            ${showReading ? `<div class="seg-card-reading">${escapeHtml(primaryReading)}</div>` : ''}
            <div class="seg-card-title">
              <span>${escapeHtml(primaryWord)}</span>
              ${posText ? `<span class="pos-tag">${escapeHtml(posText)}</span>` : ''}
              ${surfaceBadge}
            </div>
            ${meaningText ? `<div class="seg-card-gloss${tok.isParticle ? ' is-grammar' : ''}">${escapeHtml(meaningText)}</div>` : ''}
          </div>
          <div class="card-actions">
            <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">${SPEAKER_SVG}</button>
            <button class="icon-btn copy-btn" type="button" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(primaryWord)}">${COPY_SVG}</button>
            <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" title="${fav ? '取消收藏' : '加入收藏'}">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </button>
          </div>
        `;

        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openDetail(entry, inf);
        });
        card.querySelector('.fav-btn').addEventListener('click', () => toggleFavorite(entry));
        card.querySelector('[data-speak]').addEventListener('click', (e) => {
          speakJapanese(e.currentTarget.getAttribute('data-speak'));
        });
        card.querySelector('[data-copy]').addEventListener('click', (e) => {
          e.stopPropagation();
          copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
        });

        list.appendChild(card);
      });

      wrap.appendChild(list);

      if (out.exactFullMatches && out.exactFullMatches.length > 0) {
        const preview = out.exactFullMatches
          .slice(0, 2)
          .map(e => (e[0] && e[0][0]) || (e[1] && e[1][0]))
          .filter(Boolean)
          .join('、');
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'alt-link seg-exact-link';
        link.textContent = `或查看完全符合「${out.rawQuery}」的單字（${preview}）`;
        link.addEventListener('click', () => {
          closeDetail();
          currentSearchOutput.segViewMode = 'exactFull';
          currentSearchOutput.activeSegmentIndex = -1;
          resultCountEl.textContent = out.exactFullMatches.length;
          renderCurrentView();
        });
        wrap.appendChild(link);
      }

      return wrap;
    }

    // 渲染搜尋框下方的斷詞膠囊列
    function renderSegmentBar(out) {
      if (!segmentBar) return;
      if (!out || !out.isSegmented || !Array.isArray(out.tokens) || out.tokens.length === 0) {
        segmentBar.style.display = 'none';
        segmentBar.innerHTML = '';
        return;
      }

      segmentBar.innerHTML = '<span class="seg-label">斷詞：</span>';

      const overviewBtn = document.createElement('button');
      overviewBtn.type = 'button';
      const isOverview = out.segViewMode === 'overview';
      overviewBtn.className = 'seg-pill' + (isOverview ? ' active' : '');
      overviewBtn.setAttribute('role', 'tab');
      overviewBtn.setAttribute('aria-selected', isOverview ? 'true' : 'false');
      overviewBtn.textContent = '逐詞一覽';
      overviewBtn.addEventListener('click', () => {
        if (currentSearchOutput.segViewMode === 'overview') return;
        closeDetail();
        currentSearchOutput.segViewMode = 'overview';
        currentSearchOutput.activeSegmentIndex = -1;
        resultCountEl.textContent = out.tokens.length;
        renderCurrentView();
      });
      segmentBar.appendChild(overviewBtn);

      out.tokens.forEach((tok, idx) => {
        const isActive = out.segViewMode === 'token' && idx === out.activeSegmentIndex;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-pill'
          + (isActive ? ' active' : '')
          + (tok.isParticle ? ' is-particle' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        btn.textContent = tok.text;
        btn.addEventListener('click', () => {
          closeDetail();
          if (isActive) {
            currentSearchOutput.segViewMode = 'overview';
            currentSearchOutput.activeSegmentIndex = -1;
            resultCountEl.textContent = out.tokens.length;
          } else {
            currentSearchOutput.segViewMode = 'token';
            currentSearchOutput.activeSegmentIndex = idx;
            resultCountEl.textContent = tok.tokenRes.results.length;
          }
          renderCurrentView();
        });
        segmentBar.appendChild(btn);
      });

      const aiBtn = document.createElement('button');
      aiBtn.type = 'button';
      const aiState = out.aiSeg && out.aiSeg.state;
      const isAiActive = Boolean(aiState === 'done' && out.aiSeg.active);
      aiBtn.className = 'seg-ai-btn' + (isAiActive ? ' is-active' : '');
      aiBtn.disabled = aiState === 'loading';
      aiBtn.textContent = aiState === 'loading'
        ? 'AI 拆句中…'
        : isAiActive
          ? 'AI 拆句 ✓'
          : 'AI 拆句';
      aiBtn.title = isAiActive ? '點擊切回純本地規則斷詞' : '使用 AI 依語意重新拆句';
      aiBtn.addEventListener('click', () => toggleAiSegmentation(out));
      segmentBar.appendChild(aiBtn);

      segmentBar.style.display = 'flex';
    }

    function executeSmartSearch(rawQuery, opts) {
      opts = opts || {};
      const q = rawQuery.trim();
      if (!q || !isDbReady) return { mode: 'empty', results: [], note: '' };
      const qLower = q.toLowerCase();

      // 0.2 斷詞優先：超過 6 字，或含／結尾為助詞與標點（且非高頻白名單整詞）
      if (!opts.noSegment && shouldTriggerSegmentation(q)) {
        const tokens = segmentJapaneseText(q);
        if (tokens.length > 0) {
          return buildSegmentedOverview(q, tokens);
        }
      }

      // 0. 純數字（半形／全形）-> 日文數字寫法與讀法
      if (isNumericQuery(q)) {
        const info = numberToJapanese(q);
        if (info) return searchNumber(q, info);
      }

      // 0.5 含萬用字元（? ？ * ＊）-> 同時比對漢字表記與假名讀音
      if (RE_WILD.test(q)) return searchWildcard(q);

      // 1. 日文假名或混合假名漢字 -> 直接比對日文（含平片假名互通、活用形還原）
      if (hasKana(q)) {
        return searchJapaneseText(q);
      }

      // 2. 純英文 -> 搜尋英文釋義 -> 顯示對應日文與假名發音
      if (isAsciiEnglish(q)) {
        const en = searchEnglish(q, qLower);
        const kana = opts.noRomaji ? null : romajiToKana(q);
        if (!kana) return en;
        const jp = searchJapaneseText(kana, { romaji: q });
        if (jp.results.length === 0) return en;
        if (opts.forceRomaji || en.strong === 0 || (en.strong <= 10 && jp.exactCount > 0)) {
          // 羅馬拼音為主；若英文也有明確釋義，提供切回英文的連結
          if (en.strong > 0) jp.alt = { label: `改搜英文「${q}」`, opts: { noRomaji: true } };
          return jp;
        }
        // 英文為主；同時可能是羅馬拼音，提供切換連結
        en.alt = { label: `也可能是羅馬拼音「${kana}」→ 點此改搜日文讀音`, opts: { forceRomaji: true } };
        return en;
      }

      // 3. 漢字輸入 -> 若含分號／頓號多詞義（如「冰；冷；冷淡；凊」），優先做多義項交集比對；否則先查日文漢字再走中文橋接
      if (hasHanzi(q)) {
        const rawParts = q.split(/[；;、／/，,｜|]+/).map(s => s.trim()).filter(Boolean);
        if (rawParts.length >= 2) {
          const uniqueTerms = [...new Set(rawParts)];
          const termNorms = uniqueTerms.map(t => normalizeChineseForCompare(t)).filter(Boolean);
          const termBridgeSets = uniqueTerms.map(t => {
            const set = new Set();
            (zhBridge[t] || []).forEach(def => {
              def.split(';').forEach(p => {
                const clean = p.toLowerCase().replace(/\([^)]*\)/g, '').replace(/^to\s+/, '').trim();
                if (clean) set.add(clean);
              });
            });
            return set;
          });

          const scoredEntries = [];
          for (let i = 0; i < dictData.length; i++) {
            const entry = dictData[i];
            const zhs = entry[4] || [];
            const zhNormSet = new Set();
            for (let z = 0; z < zhs.length; z++) {
              const norm = normalizeChineseForCompare(stripParens(zhs[z]));
              if (norm) zhNormSet.add(norm);
            }

            let directHits = 0;
            for (let tIdx = 0; tIdx < termNorms.length; tIdx++) {
              if (zhNormSet.has(termNorms[tIdx])) directHits++;
            }

            let bridgeHits = 0;
            if (directHits < termNorms.length && Array.isArray(entry[3])) {
              const entryEnSet = new Set();
              for (let s = 0; s < entry[3].length; s++) {
                const gs = entry[3][s].g || [];
                for (let g = 0; g < gs.length; g++) {
                  const gClean = gs[g].toLowerCase().replace(/\([^)]*\)/g, '').replace(/^to\s+/, '').trim();
                  if (gClean) entryEnSet.add(gClean);
                }
              }
              if (entryEnSet.size > 0) {
                for (let tIdx = 0; tIdx < termBridgeSets.length; tIdx++) {
                  if (zhNormSet.has(termNorms[tIdx])) continue;
                  const bSet = termBridgeSets[tIdx];
                  for (const kw of bSet) {
                    if (entryEnSet.has(kw)) {
                      bridgeHits++;
                      break;
                    }
                  }
                }
              }
            }

            const totalHits = directHits + bridgeHits * 0.75;
            if (totalHits > 0) {
              scoredEntries.push({
                entry,
                directHits,
                totalHits,
                core: coreBase(entry) + (entry[2] ? 30 : 0)
              });
            }
          }

          if (scoredEntries.length > 0) {
            scoredEntries.sort((a, b) =>
              (b.directHits - a.directHits) ||
              (b.totalHits - a.totalHits) ||
              (b.core - a.core)
            );
            const deduped = [];
            const seenIds = new Set();
            for (const item of scoredEntries) {
              const id = getEntryId(item.entry);
              if (!seenIds.has(id)) {
                seenIds.add(id);
                deduped.push(item.entry);
                if (deduped.length >= 50) break;
              }
            }
            return {
              mode: 'zh',
              badge: '多義項比對 → 日文',
              note: `已拆解 ${uniqueTerms.length} 個中文釋義（${uniqueTerms.slice(0, 4).join('、')}），依符合度排序`,
              results: deduped
            };
          }
        }

        const jpExact = [];
        const jpPartial = [];
        for (let i = 0; i < dictData.length; i++) {
          const entry = dictData[i];
          const kanjis = entry[0];
          if (kanjis.includes(q)) {
            jpExact.push(entry);
          } else if (jpPartial.length < 50 && kanjis.some(k => k.includes(q))) {
            jpPartial.push(entry);
          }
        }

        if (jpExact.length > 0 || jpPartial.length > 0) {
          jpPartial.sort((a, b) => (b[2] - a[2]) || (coreBase(b) - coreBase(a)));
          return {
            mode: 'jp',
            badge: '漢字優先（命中日文漢字）',
            note: `日文辭典中直接收錄「${q}」`,
            results: [...rankByCoreScore(jpExact, [q]), ...jpPartial].slice(0, 50)
          };
        }

        // 日文無此漢字 -> 當中文查 zhBridge -> 英文關鍵字 -> 反查 dictData
        const enBridges = zhBridge[q] || [];
        const keywords = [];
        for (const def of enBridges) {
          const parts = def.split(';').map(s => s.trim().toLowerCase()).filter(Boolean);
          for (const p of parts) {
            const clean = p.replace(/^to\s+/, '').trim();
            if (clean && !keywords.includes(clean)) keywords.push(clean);
          }
        }

        const bridgedExact = [];
        const bridgedPartial = [];

        if (keywords.length > 0) {
          for (let i = 0; i < dictData.length; i++) {
            const entry = dictData[i];
            const senses = entry[3];
            let score = 0;
            for (let j = 0; j < senses.length; j++) {
              const glosses = senses[j].g;
              for (let k = 0; k < glosses.length; k++) {
                const gClean = glosses[k].toLowerCase().replace(/\([^)]*\)/g, '').replace(/^to\s+/, '').trim();
                for (const kw of keywords) {
                  if (gClean === kw) {
                    score = 2;
                    break;
                  } else if (score < 1 && bridgedPartial.length < 60 && gClean.includes(kw) && kw.length >= 3) {
                    score = 1;
                  }
                }
                if (score === 2) break;
              }
              if (score === 2) break;
            }
            if (score === 2) bridgedExact.push(entry);
            else if (score === 1) bridgedPartial.push(entry);
            if (bridgedExact.length >= 60) break;
          }
        }

        const tagMatches = [];
        if (bridgedExact.length + bridgedPartial.length < 30) {
          for (let i = 0; i < dictData.length; i++) {
            const entry = dictData[i];
            const zhs = entry[4] || [];
            if (zhs.includes(q) && !bridgedExact.includes(entry) && !bridgedPartial.includes(entry)) {
              tagMatches.push(entry);
              if (tagMatches.length >= 30) break;
            }
          }
        }

        const rankedExact = rankByCoreScore(bridgedExact, []);
        const rankedPartial = rankByCoreScore(bridgedPartial, []);
        const rankedTags = rankByCoreScore(tagMatches, []);

        return {
          mode: 'zh',
          badge: '中文轉譯 → 日文',
          note: keywords.length > 0
            ? `日文無此漢字，已透過英文橋接詞（${keywords.slice(0, 3).join(', ')}）找出對應日文`
            : `日文無此漢字，嘗試以中文語意反查「${q}」`,
          results: [...rankedExact, ...rankedPartial, ...rankedTags].slice(0, 50)
        };
      }

      return { mode: 'empty', results: [], note: '' };
    }


    // ===== 變化形引擎 =====
    const GODAN = {
      'う': { a: 'わ', i: 'い', e: 'え', o: 'お', te: 'って', ta: 'った' },
      'く': { a: 'か', i: 'き', e: 'け', o: 'こ', te: 'いて', ta: 'いた' },
      'ぐ': { a: 'が', i: 'ぎ', e: 'げ', o: 'ご', te: 'いで', ta: 'いだ' },
      'す': { a: 'さ', i: 'し', e: 'せ', o: 'そ', te: 'して', ta: 'した' },
      'つ': { a: 'た', i: 'ち', e: 'て', o: 'と', te: 'って', ta: 'った' },
      'ぬ': { a: 'な', i: 'に', e: 'ね', o: 'の', te: 'んで', ta: 'んだ' },
      'ぶ': { a: 'ば', i: 'び', e: 'べ', o: 'ぼ', te: 'んで', ta: 'んだ' },
      'む': { a: 'ま', i: 'み', e: 'め', o: 'も', te: 'んで', ta: 'んだ' },
      'る': { a: 'ら', i: 'り', e: 'れ', o: 'ろ', te: 'って', ta: 'った' }
    };

    const POS_LABELS = {
      'n': '名詞', 'vs': '可加「する」', 'vt': '他動詞', 'vi': '自動詞', 'exp': '慣用表現',
      'adj-no': 'の形容詞', 'adj-na': 'な形容詞', 'adj-i': 'い形容詞', 'adj-ix': 'い形容詞（いい型）',
      'adj-f': '連體修飾', 'adj-pn': '連體詞', 'adj-t': 'たる形容詞', 'adv': '副詞', 'adv-to': '副詞（と）',
      'n-suf': '名詞性接尾詞', 'n-pref': '名詞性接頭詞', 'suf': '接尾詞', 'pref': '接頭詞', 'int': '感嘆詞',
      'pn': '代名詞', 'prt': '助詞', 'conj': '接續詞', 'ctr': '量詞', 'num': '數詞', 'unc': '未分類',
      'aux-v': '助動詞', 'aux': '輔助詞', 'v1': '一段動詞', 'v1-s': '一段動詞', 'vk': '来る（不規則）',
      'vs-i': 'する（不規則）', 'vs-s': 'する動詞（特殊）', 'vs-c': 'す動詞', 'vz': 'ずる動詞',
      'v5aru': '五段動詞（ある型）', 'v5r-i': '五段動詞（ある）', 'v5k-s': '五段動詞（行く）', 'v5u-s': '五段動詞（特殊）'
    };

    function posLabel(tag) {
      if (POS_LABELS[tag]) return POS_LABELS[tag];
      if (/^v5/.test(tag)) return '五段動詞';
      if (/^v[24]/.test(tag)) return '古語動詞';
      return tag;
    }

    // =====================================================================
    //  變化形產生：例外覆寫表（Exception Override Map）→ 辭典詞性標籤 → 通用規則
    //  優先順序：例外覆寫 > 辭典標籤（如 v5r）> 通用規則；不會用字尾去猜詞性。
    // =====================================================================

    const ARU_HONORIFIC = ['いらっしゃる', 'おっしゃる', 'くださる', 'なさる', 'ござる', 'おいでなさる',
      '仰る', '下さる', '為さる', '御座る', '御出でなさる'];
    const V5U_S_WORDS = ['問う', '請う', '乞う', '厭う', '恋う'];
    // 標籤缺漏時的安全網：這些「長得像一段」的字一定是五段（v5r）
    const V5R_SAFETY = ['帰る', '走る', '入る', '切る', '知る', '滑る', '要る', '限る', '参る', '握る', '減る',
      '蹴る', '練る', '湿る', '喋る', '焦る', '散る', '照る', '捻る', '遮る', '覆る', 'しゃべる'];
    // 詞本身已含「可能／自發」語意：不再重複生成可能形
    const AUTO_POTENTIAL = [['見える', 'みえる'], ['聞こえる', 'きこえる'], ['分かる', 'わかる'], ['判る', 'わかる'],
      ['解る', 'わかる'], ['出来る', 'できる'], ['思える', 'おもえる']];
    // 無意志的自然現象：沒有命令形、意志形、禁止形
    const NATURAL_PHENOMENON = [['降る', 'ふる'], ['積もる', 'つもる'], ['晴れる', 'はれる'], ['曇る', 'くもる'],
      ['照る', 'てる'], ['止む', 'やむ'], ['咲く', 'さく'], ['散る', 'ちる'], ['枯れる', 'かれる'],
      ['凍る', 'こおる'], ['溶ける', 'とける'], ['実る', 'みのる']];
    // 連體詞、特殊形容動詞：不顯示變化表
    const NO_CONJ_WORDS = ['同じ', 'おなじ', 'いろんな', '色んな', 'こんな', 'そんな', 'あんな', 'どんな',
      '大きな', '小さな', 'おかしな'];

    // 在 words 清單內（以漢字表記比對；沒有漢字表記的詞才用讀音比對）
    function listHas(entry, list) {
      for (const w of entry[0]) if (list.includes(w)) return true;
      if (entry[0].length === 0) for (const r of entry[1]) if (list.includes(r)) return true;
      return false;
    }
    // 以「表記＋讀音」成對比對，避免同形異讀（例如 降る／下る）誤判
    function pairHas(entry, pairs) {
      return pairs.some(([w, r]) => entry[1].includes(r) && (entry[0].includes(w) || entry[0].length === 0));
    }

    const VERB_TAGS_RE = /^(v1|v5|vk|vs|vz|v2|v4)/;

    // 第一層：詞性類型覆寫（先於辭典標籤判斷）
    const CONJ_TYPE_OVERRIDES = [
      { // 敬語五段：ます形為 〜います、命令形為 〜い
        name: 'aru-honorific',
        test: (e) => listHas(e, ARU_HONORIFIC) || e[1].some(r => /(?:なさる|くださる|いらっしゃる|おっしゃる)$/.test(r)),
        type: () => ({ kind: 'godan', tag: 'v5aru', title: '五段動詞（敬語）' })
      },
      { // 行く：て形／た形為 って／った
        name: 'iku',
        test: (e, tags) => (tags.has('v5k') || tags.has('v5k-s') || ![...tags].some(t => VERB_TAGS_RE.test(t))) &&
          (e[0].some(w => /[行往]く$/.test(w)) || (e[0].length === 0 && e[1].some(r => /^(?:いく|ゆく)$/.test(r)))),
        type: () => ({ kind: 'godan', tag: 'v5k-s', title: '五段動詞（行く型）' })
      },
      { // 問う・請う・乞う・厭う：て形／た形為 〜うて／〜うた
        name: 'tou',
        test: (e, tags) => listHas(e, V5U_S_WORDS) && (tags.has('v5u') || tags.has('v5u-s')),
        type: () => ({ kind: 'godan', tag: 'v5u-s', title: '五段動詞（問う型）' })
      },
      { // 標籤缺漏時的安全網：帰る、走る、入る、切る、知る、滑る…一律當五段
        name: 'v5r-safety',
        test: (e, tags) => ![...tags].some(t => VERB_TAGS_RE.test(t)) && listHas(e, V5R_SAFETY),
        type: () => ({ kind: 'godan', tag: 'v5r', title: '五段動詞' })
      }
    ];

    function detectConjType(entry, tags) {
      tags = tags || entryTagSet(entry);
      for (const ov of CONJ_TYPE_OVERRIDES) {
        if (ov.test(entry, tags)) return ov.type();
      }
      // 第二層：辭典標籤。五段（含特殊五段）優先於一段，不看字尾
      if (tags.has('vk')) return { kind: 'kuru', title: '来る（カ変動詞）' };
      if (tags.has('vs-i')) return { kind: 'suru', tag: 'vs-i', title: 'する（サ変動詞）' };
      if (tags.has('vs-s')) return { kind: 'suru', tag: 'vs-s', title: 'する動詞（特殊）' };
      const special = ['v5k-s', 'v5u-s', 'v5r-i', 'v5aru'].find(t => tags.has(t));
      const v5 = special || [...tags].find(t => /^v5/.test(t));
      if (v5) return { kind: 'godan', tag: v5, title: '五段動詞' };
      if (tags.has('v1') || tags.has('v1-s')) {
        return { kind: 'ichidan', tag: tags.has('v1') ? 'v1' : 'v1-s', title: '一段動詞' };
      }
      if (tags.has('adj-ix')) return { kind: 'adj-i', title: 'い形容詞（いい型）' };
      if (tags.has('adj-i')) return { kind: 'adj-i', title: 'い形容詞' };
      if (tags.has('adj-na')) return { kind: 'adj-na', title: 'な形容詞' };
      if (tags.has('vs')) return { kind: 'suru-noun', title: '名詞＋する' };
      return null;
    }

    // 第三層：個別例外（決定哪些形態省略、哪些走特殊寫法）
    const CONJ_EXCEPTIONS = [
      { name: 'ある（有る）：沒有可能／被動／使役／命令',
        test: (e, t, ty) => ty.tag === 'v5r-i',
        apply: (p) => ['pot', 'pass', 'caus', 'imp', 'proh'].forEach(k => p.omit.add(k)) },
      { name: '敬語動詞：不用可能／被動／使役；ござる 另無命令形',
        test: (e, t, ty) => ty.tag === 'v5aru',
        apply: (p, e) => {
          ['pot', 'pass', 'caus'].forEach(k => p.omit.add(k));
          if (listHas(e, ['ござる', '御座る'])) { p.omit.add('imp'); p.omit.add('proh'); }
        } },
      { name: '愛する：否定為 愛さない',
        test: (e) => e[0].includes('愛する') || e[1].includes('あいする'),
        apply: (p) => { p.suruSpecial = 'ai'; } },
      { name: '一字漢語サ変（達する等）：不用使役形',
        test: (e, t, ty) => ty.tag === 'vs-s',
        apply: (p) => { if (p.suruSpecial !== 'ai') p.omit.add('caus'); } },
      { name: '自身含可能／自發語意',
        test: (e) => pairHas(e, AUTO_POTENTIAL),
        apply: (p) => p.omit.add('pot') },
      { name: '無意志自然現象',
        test: (e) => pairHas(e, NATURAL_PHENOMENON),
        apply: (p) => ['imp', 'vol', 'proh'].forEach(k => p.omit.add(k)) },
      { name: 'いい／よい 系形容詞：過去、否定走 よ- 詞幹（かわいい 除外）',
        test: (e, t, ty) => ty.kind === 'adj-i' &&
          (t.has('adj-ix') || (e[1].some(r => /いい$/.test(r)) && !e[1].some(r => /(?:かわいい|かいい)$/.test(r)))),
        apply: (p) => { p.yoi = true; } }
    ];

    const VERB_LABELS = {
      dict: '辞書形（原形）', masu: 'ます形（禮貌）', masuPast: 'ました（禮貌過去）', masuNeg: 'ません（禮貌否定）',
      neg: 'ない形（否定）', negPast: 'なかった形（過去否定）', ta: 'た形（過去）', te: 'て形', ba: 'ば形（假設）',
      pot: '可能形', pass: '受身形（被動）', caus: '使役形', vol: '意志形（…吧）', imp: '命令形', proh: '禁止形（不要…）'
    };
    const ADJI_LABELS = {
      dict: '辞書形（原形）', polite: '禮貌', neg: '否定', past: '過去', negPast: '過去否定',
      te: 'て形', adv: '副詞形', nom: '名詞化', ba: 'ば形（假設）'
    };
    const ADJNA_LABELS = {
      dict: '辞書形（原形）', attr: '修飾名詞', neg: '否定', past: '過去', negPast: '過去否定', te: 'て形',
      adv: '副詞形', polite: '禮貌', politeNeg: '禮貌否定', cond: '條件'
    };

    function godanForms(base, tag) {
      const m = GODAN[base.slice(-1)];
      if (!m) return null;
      const st = base.slice(0, -1);
      let te = m.te, ta = m.ta, iS = m.i, imp = st + m.e;
      if (tag === 'v5k-s') { te = 'って'; ta = 'った'; }
      if (tag === 'v5u-s') { te = 'うて'; ta = 'うた'; }
      if (tag === 'v5aru') { iS = 'い'; imp = st + 'い'; }
      const neg = tag === 'v5r-i' ? 'ない' : st + m.a + 'ない';
      return {
        dict: base, masu: st + iS + 'ます', masuPast: st + iS + 'ました', masuNeg: st + iS + 'ません',
        neg, negPast: neg.slice(0, -1) + 'かった', ta: st + ta, te: st + te, ba: st + m.e + 'ば',
        pot: st + m.e + 'る', pass: st + m.a + 'れる', caus: st + m.a + 'せる', vol: st + m.o + 'う',
        imp, proh: base + 'な'
      };
    }

    function ichidanForms(base, tag) {
      if (!base.endsWith('る')) return null;
      const st = base.slice(0, -1);
      return {
        dict: base, masu: st + 'ます', masuPast: st + 'ました', masuNeg: st + 'ません',
        neg: st + 'ない', negPast: st + 'なかった', ta: st + 'た', te: st + 'て', ba: st + 'れば',
        pot: st + 'られる', pass: st + 'られる', caus: st + 'させる', vol: st + 'よう',
        imp: tag === 'v1-s' ? st : st + 'ろ',          // くれる → くれ（不是 くれろ）
        proh: base + 'な'
      };
    }

    function suruForms(pref, tag, special) {
      const ai = special === 'ai';
      const vsS = tag === 'vs-s';
      return {
        dict: pref + 'する', masu: pref + 'します', masuPast: pref + 'しました', masuNeg: pref + 'しません',
        neg: pref + (ai ? 'さない' : 'しない'), negPast: pref + (ai ? 'さなかった' : 'しなかった'),
        ta: pref + 'した', te: pref + 'して', ba: pref + 'すれば',
        pot: pref + (ai ? 'せる' : vsS ? 'せられる' : 'できる'),
        pass: pref + 'される', caus: pref + 'させる',
        vol: pref + (ai ? 'そう' : 'しよう'), imp: pref + (ai ? 'せ' : 'しろ'), proh: pref + 'するな'
      };
    }

    // c：こ／き／く 三種讀音（漢字表記時三者相同，都寫「来」）
    function kuruForms(pref, c) {
      return {
        dict: pref + c.ku + 'る', masu: pref + c.ki + 'ます', masuPast: pref + c.ki + 'ました', masuNeg: pref + c.ki + 'ません',
        neg: pref + c.ko + 'ない', negPast: pref + c.ko + 'なかった', ta: pref + c.ki + 'た', te: pref + c.ki + 'て',
        ba: pref + c.ku + 'れば', pot: pref + c.ko + 'られる', pass: pref + c.ko + 'られる', caus: pref + c.ko + 'させる',
        vol: pref + c.ko + 'よう', imp: pref + c.ko + 'い', proh: pref + c.ku + 'るな'
      };
    }

    function adjIForms(base, yoi) {
      if (!base.endsWith('い')) return null;
      // いい系：かっこいい → かっこよくない／かっこよかった
      const st = (yoi && base.endsWith('いい')) ? base.slice(0, -2) + 'よ' : base.slice(0, -1);
      return {
        dict: base, polite: base + 'です', neg: st + 'くない', past: st + 'かった', negPast: st + 'くなかった',
        te: st + 'くて', adv: st + 'く', nom: st + 'さ', ba: st + 'ければ'
      };
    }

    function adjNaForms(base) {
      return {
        dict: base, attr: base + 'な', neg: base + 'じゃない', past: base + 'だった', negPast: base + 'じゃなかった',
        te: base + 'で', adv: base + 'に', polite: base + 'です', politeNeg: base + 'ではありません', cond: base + 'なら'
      };
    }

    function formsFor(type, base, plan) {
      switch (type.kind) {
        case 'godan': return godanForms(base, type.tag);
        case 'ichidan': return ichidanForms(base, type.tag);
        case 'adj-i': return adjIForms(base, plan.yoi);
        case 'adj-na': return adjNaForms(base);
        case 'suru-noun': return suruForms(base, 'vs', null);
        case 'suru':
          return base.endsWith('する') ? suruForms(base.slice(0, -2), type.tag, plan.suruSpecial) : null;
        case 'kuru':
          if (base.endsWith('来る') || base.endsWith('來る')) {
            const k = base.charAt(base.length - 2);
            return kuruForms(base.slice(0, -2), { ko: k, ki: k, ku: k });
          }
          if (base.endsWith('くる')) return kuruForms(base.slice(0, -2), { ko: 'こ', ki: 'き', ku: 'く' });
          return null;
      }
      return null;
    }

    function labelsFor(kind) {
      if (kind === 'adj-i') return ADJI_LABELS;
      if (kind === 'adj-na') return ADJNA_LABELS;
      return VERB_LABELS;
    }

    function buildConjugation(entry) {
      if (listHas(entry, NO_CONJ_WORDS)) return null;
      const tags = entryTagSet(entry);
      const type = detectConjType(entry, tags);
      if (!type) return null;
      // 以「な」結尾的連體型（いろんな 等）不是真正的な形容詞
      if (type.kind === 'adj-na' && entry[0].concat(entry[1]).every(f => f.endsWith('な'))) return null;

      const plan = { omit: new Set(), suruSpecial: null, yoi: false };
      CONJ_EXCEPTIONS.forEach(ex => { if (ex.test(entry, tags, type)) ex.apply(plan, entry); });

      const written = entry[0][0] || null;
      const reading = entry[1][0] || null;
      const wF = written ? formsFor(type, written, plan) : null;
      const rF = reading ? formsFor(type, reading, plan) : null;
      const base = wF || rF;
      if (!base) return null;

      const labels = labelsFor(type.kind);
      const rows = [];
      Object.keys(labels).forEach(id => {
        if (plan.omit.has(id) || base[id] == null) return;
        rows.push({
          label: labels[id],
          written: wF && wF[id] != null ? wF[id] : null,
          reading: rF && rF[id] != null ? rF[id] : null
        });
      });
      const title = plan.yoi ? 'い形容詞（いい・よい型）' : type.title;
      return { title, rows };
    }

    // ===== 詳細頁 =====
    let currentDetail = null;
    let savedScrollY = 0;

    let currentDetailInf = null;

    function openDetail(entry, inf) {
      recordStudiedWord(entry);
      savedScrollY = window.scrollY;
      currentDetail = entry;
      currentDetailInf = inf || null;
      try { history.pushState({ detail: true }, ''); } catch (e) {}
      renderCurrentView();
      window.scrollTo(0, 0);
    }

    function closeDetail() {
      if (!currentDetail) return false;
      currentDetail = null;
      currentDetailInf = null;
      try { if (history.state && history.state.detail) history.replaceState(null, ''); } catch (e) {}
      return true;
    }

    window.addEventListener('popstate', () => {
      if (currentDetail) {
        currentDetail = null;
        renderCurrentView();
        window.scrollTo(0, savedScrollY);
      }
    });

    const SPEAKER_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    const COPY_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const CHECK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    async function copyWordText(text, btnEl) {
      const val = String(text || '').trim();
      if (!val) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          const ta = document.createElement('textarea');
          ta.value = val;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        if (btnEl) {
          const origHtml = btnEl.innerHTML;
          btnEl.classList.add('is-copied');
          btnEl.innerHTML = CHECK_SVG;
          clearTimeout(btnEl._copyTimer);
          btnEl._copyTimer = setTimeout(() => {
            btnEl.classList.remove('is-copied');
            btnEl.innerHTML = origHtml;
          }, 1100);
        }
      } catch (e) {}
    }

    function renderDetailPage(entry, inf) {
      const [kanjis, kanas, isCommon, senses, zhs] = entry;
      const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
      const primaryReading = kanas[0] || '';
      const fav = isFavorite(entry);
      const page = document.createElement('div');
      page.className = 'detail-page';

      const otherKanji = kanjis.slice(1);
      const otherKana = kanjis.length > 0 ? kanas.slice(1) : kanas.slice(1);
      const formsHtml = (kanjis.length > 1 || kanas.length > 1) ? `
        <div class="detail-forms">
          ${otherKanji.length ? `<div><span class="forms-label">其他表記</span>${escapeHtml(otherKanji.join('・'))}</div>` : ''}
          ${otherKana.length ? `<div><span class="forms-label">其他讀音</span>${escapeHtml(otherKana.join('・'))}</div>` : ''}
        </div>` : '';

      const zhHtml = (zhs && zhs.length > 0)
        ? `<div class="zh-meanings">${zhs.map(z => `<span class="zh-pill">${escapeHtml(z)}</span>`).join('')}</div>` : '';

      const sensesHtml = senses.map((sn, idx) => {
        const pos = (sn.p || []).map(t => `<span class="pos-tag">${escapeHtml(posLabel(t))}</span>`).join('');
        const exs = (sn.e || []).map(([jp, en]) => `
          <div class="example-box">
            <div class="ex-jp"><span>${escapeHtml(jp)}</span>
              <button class="mini-speak" title="朗讀例句" data-speak="${escapeHtml(jp)}">${SPEAKER_SVG.replace(/width="17" height="17"/, 'width="15" height="15"')}</button>
            </div>
            <div class="ex-en">${escapeHtml(en)}</div>
          </div>`).join('');
        return `<div class="sense-item"><span class="sense-no">${idx + 1}</span>${pos}<span class="en-gloss">${escapeHtml(sn.g.join('; '))}</span>${exs}</div>`;
      }).join('');

      const conj = buildConjugation(entry);
      const hitVariants = inf ? kanaVariants(inf.surface) : [];
      const isHitRow = r => hitVariants.length > 0 && (hitVariants.includes(r.written) || hitVariants.includes(r.reading));
      const hasHit = !!(conj && conj.rows.some(isHitRow));
      let hitHtml = '';
      if (inf) {
        const chain = inf.path.slice().reverse().join(' → ');
        hitHtml = `<div class="detail-hit">你搜尋的「${escapeHtml(inf.surface)}」是 ${escapeHtml(inf.base)} 的變化形：${escapeHtml(chain)}${escapeHtml(inflectionExtra(inf))}${hasHit ? ' <button class="hit-jump" id="hitJump">看變化表 ↓</button>' : ''}</div>`;
      }
      let conjHtml = '';
      if (conj) {
        conjHtml = `
          <section class="detail-section">
            <h3 class="detail-h">變化形 <span class="detail-h-sub">${escapeHtml(conj.title)}</span></h3>
            <div class="conj-table">
              ${conj.rows.map(r => {
                const hit = isHitRow(r);
                const main = r.written || r.reading;
                const sub = (r.written && r.reading && r.reading !== r.written) ? `<div class="conj-reading">${escapeHtml(r.reading)}</div>` : '';
                const sp = r.reading || r.written;
                return `<div class="conj-row${hit ? ' conj-hit' : ''}">
                  <div class="conj-label">${escapeHtml(r.label)}${hit ? '<span class="hit-badge">你搜的形態</span>' : ''}</div>
                  <div class="conj-form"><div class="conj-main">${escapeHtml(main)}</div>${sub}</div>
                  <button class="mini-speak" title="朗讀" data-speak="${escapeHtml(sp)}">${SPEAKER_SVG.replace(/width="17" height="17"/, 'width="15" height="15"')}</button>
                </div>`;
              }).join('')}
            </div>
            <p class="conj-note">※ 變化形已涵蓋常見例外，罕見詞或古語請以專業辭典為準。</p>
          </section>`;
      }

      page.innerHTML = `
        <button class="back-btn" id="detailBack">‹ 返回</button>
        <article class="word-card detail-head">
          <div class="card-header">
            <div class="word-title-group">
              ${kanjis.length > 0 ? `<div class="kana-reading">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="kanji-main detail-title">
                <span>${escapeHtml(primaryWord)}</span>
                ${isCommon ? '<span class="common-badge">常用</span>' : ''}
              </div>
            </div>
            <div class="card-actions">
              <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">${SPEAKER_SVG}</button>
              <button class="icon-btn copy-btn" type="button" id="detailCopy" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(primaryWord)}">${COPY_SVG}</button>
              <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" id="detailFav" title="${fav ? '取消收藏' : '加入收藏'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
              </button>
            </div>
          </div>
          ${formsHtml}
          ${zhHtml}
          ${hitHtml}
        </article>
        <section class="detail-section">
          <h3 class="detail-h">釋義與例句</h3>
          <div class="senses-list detail-senses">${sensesHtml}</div>
        </section>
        ${conjHtml}
      `;

      page.querySelector('#detailBack').addEventListener('click', () => {
        if (history.state && history.state.detail) history.back();
        else { closeDetail(); renderCurrentView(); window.scrollTo(0, savedScrollY); }
      });
      page.querySelector('#detailFav').addEventListener('click', () => toggleFavorite(entry));
      const detailCopyBtn = page.querySelector('#detailCopy');
      if (detailCopyBtn) {
        detailCopyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
        });
      }
      const jump = page.querySelector('#hitJump');
      if (jump) jump.addEventListener('click', () => {
        const row = page.querySelector('.conj-hit');
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      page.querySelectorAll('[data-speak]').forEach(btn => {
        btn.addEventListener('click', () => speakJapanese(btn.getAttribute('data-speak')));
      });
      return page;
    }

    function speakJapanese(text) {
      if (!('speechSynthesis' in window)) {
        alert('您的瀏覽器不支援語音朗讀功能。');
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ja-JP';
      utter.rate = 0.92;
      window.speechSynthesis.speak(utter);
    }

    function getEntryId(entry) {
      return entryIdFromTuple(entry);
    }

    function isFavorite(entry) {
      const id = getEntryId(entry);
      return favoritesStore.items.some(it => it.id === id && !it.deleted);
    }

    function toggleFavorite(entry, skipMainRerender = false) {
      const id = getEntryId(entry);
      if (!id) return;
      const now = Date.now();
      const idx = favoritesStore.items.findIndex(it => it.id === id);
      if (idx >= 0) {
        const cur = favoritesStore.items[idx];
        const nextDeleted = !cur.deleted;
        favoritesStore.items[idx] = {
          id,
          entry: cur.entry || entry,
          updatedAt: now,
          deleted: nextDeleted
        };
      } else {
        favoritesStore.items.unshift({ id, entry, updatedAt: now, deleted: false });
      }
      favoritesStore.updatedAt = now;
      refreshDerivedCollections();
      safeWriteJson(STORAGE_KEYS.favs, favoritesStore);
      updateCounts();
      scheduleCloudSyncPush();
      if (!skipMainRerender) renderCurrentView();
    }

    function addHistory(query) {
      const q = query.trim();
      if (!q) return;
      const nowDate = new Date();
      const nowTs = nowDate.getTime();
      const timeStr = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
      historyStore.items = historyStore.items.filter(item => item.q !== q);
      historyStore.items.unshift({ q, time: timeStr, updatedAt: nowTs });
      if (historyStore.items.length > COLLECTION_LIMITS.history) historyStore.items.length = COLLECTION_LIMITS.history;
      historyStore.updatedAt = nowTs;
      refreshDerivedCollections();
      safeWriteJson(STORAGE_KEYS.hist, historyStore);
      updateCounts();
      scheduleCloudSyncPush();
    }

    function clearHistory() {
      const nowTs = Date.now();
      historyStore = {
        version: 2,
        updatedAt: nowTs,
        clearedAt: nowTs,
        items: []
      };
      refreshDerivedCollections();
      safeWriteJson(STORAGE_KEYS.hist, historyStore);
      updateCounts();
      scheduleCloudSyncPush();
      renderCurrentView();
    }

    function updateCounts() {
      if (favCountEl) {
        favCountEl.textContent = favorites.length;
        favCountEl.style.display = favorites.length ? '' : 'none';
      }
      if (histCountEl) {
        histCountEl.style.display = 'none';
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderWordCards(entries, notes) {
      if (!entries || entries.length === 0) {
        return `<div class="empty-state">
          <strong>找不到相符的單字</strong>
          <p>請嘗試其他假名、漢字或英文關鍵字。</p>
        </div>`;
      }

      const container = document.createElement('div');
      container.className = 'word-list';

      const grouped = !!(notes && notes.size > 0);
      let lastGroup = '';
      const surfaceText = grouped ? [...notes.values()][0].surface : '';

      entries.forEach((entry) => {
        if (grouped) {
          const grp = notes.has(entry) ? 'infl' : (lastGroup === 'infl' || lastGroup === 'other' ? 'other' : 'exact');
          if (grp !== lastGroup) {
            const lab = document.createElement('div');
            lab.className = 'group-label';
            lab.textContent = grp === 'exact' ? '直接命中' : grp === 'infl' ? `可能的原形（由「${surfaceText}」還原）` : '其他相近的詞';
            container.appendChild(lab);
            lastGroup = grp;
          }
        }
        const [kanjis, kanas, isCommon, senses, zhs] = entry;
        const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
        const primaryReading = toHiragana(kanas[0] || '');
        const showReading = kanjis.length > 0 && primaryReading && primaryReading !== primaryWord;

        const fav = isFavorite(entry);
        const card = document.createElement('article');
        card.className = 'word-card';

        let inflHtml = '';
        const inf = notes && notes.get(entry);
        if (inf) {
          const chain = inf.path.slice().reverse().join(' → ');
          inflHtml = `<div class="infl-note"><strong>${escapeHtml(inf.surface)}</strong> 是 <strong>${escapeHtml(inf.base)}</strong> 的變化形　${escapeHtml(chain)}${escapeHtml(inflectionExtra(inf))}</div>`;
        }

        const cleanZhs = (zhs || []).filter(z => !/[㐀-䶿]/.test(z));
        let zhHtml = '';
        if (cleanZhs.length > 0) {
          zhHtml = `<div class="zh-meanings zh-compact">${cleanZhs.map(z => `<span class="zh-pill">${escapeHtml(z)}</span>`).join('')}</div>`;
        } else if (senses && senses[0] && senses[0].g && senses[0].g.length > 0) {
          const enPreview = senses[0].g.slice(0, 3).join('; ');
          const cachedWordZh = aiWordZhCache.get(`ja-word|zh-TW|${primaryWord}`);
          if (cachedWordZh && cachedWordZh.text) {
            zhHtml = `<div class="zh-meanings zh-compact"><span class="zh-pill">${escapeHtml(cachedWordZh.text)}</span><span class="card-gloss-sub">（${escapeHtml(enPreview)}）</span></div>`;
          } else {
            zhHtml = `<div class="card-gloss-fallback"><span>${escapeHtml(enPreview)}</span><button type="button" class="inline-ai-zh-btn" data-ai-word-zh="${escapeHtml(primaryWord)}" data-en-hint="${escapeHtml(enPreview)}">補中文</button></div>`;
          }
        }

        const hasBelow = Boolean(inflHtml || zhHtml);

        card.innerHTML = `
          <div class="card-header${hasBelow ? ' has-below' : ''}">
            <div class="word-title-group">
              ${showReading ? `<div class="kana-reading">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="kanji-main">
                <span>${escapeHtml(primaryWord)}</span>
                ${isCommon ? '<span class="common-badge">常用</span>' : ''}
              </div>
            </div>
            <div class="card-actions">
              <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
              </button>
              <button class="icon-btn copy-btn" type="button" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(primaryWord)}">${COPY_SVG}</button>
              <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" title="${fav ? '取消收藏' : '加入收藏'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
              </button>
            </div>
          </div>
          ${inflHtml}
          ${zhHtml}
        `;
        card.classList.add('clickable');
        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openDetail(entry, inf || null);
        });

        card.querySelector('.fav-btn').addEventListener('click', () => toggleFavorite(entry));
        card.querySelectorAll('[data-speak]').forEach(btn => {
          btn.addEventListener('click', () => speakJapanese(btn.getAttribute('data-speak')));
        });
        card.querySelectorAll('[data-copy]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyWordText(btn.getAttribute('data-copy'), btn);
          });
        });

        container.appendChild(card);
      });

      return container;
    }

    function performSearch(query, saveHist = true) {
      clearBtn.style.display = query ? 'flex' : 'none';
      closeDetail();
      const token = ++searchToken;
      clearTimeout(translateTimer);
      clearTimeout(aiSegTimer);
      currentSearchOutput = executeSmartSearch(query);
      const displayCount = currentSearchOutput.isSegmented
        ? currentSearchOutput.tokens.length
        : currentSearchOutput.results.length;
      resultCountEl.textContent = displayCount;
      resultCountEl.style.display = query.trim() ? '' : 'none';

      const q = query.trim();
      const needTranslate = isDbReady && q && !currentSearchOutput.isSegmented
        && currentSearchOutput.results.length === 0
        && currentSearchOutput.mode !== 'num' && currentSearchOutput.mode !== 'wild';
      if (needTranslate) {
        currentSearchOutput.translate = { state: 'loading', query: q };
        startTranslate(q, token);
      }

      // 長句（超過 6 個字）且有可用 AI 拆句服務時，先顯示本地斷詞並自動背景增強
      if (isDbReady && currentSearchOutput.isSegmented && [...q].length > 6 && isAiSegmentAvailable()) {
        const segTarget = currentSearchOutput;
        aiSegTimer = setTimeout(() => {
          if (token === searchToken && currentSearchOutput === segTarget) {
            triggerAiSegmentation(segTarget, token, false);
          }
        }, 420);
      }

      if (saveHist && q && (currentSearchOutput.isSegmented || currentSearchOutput.results.length > 0 || currentSearchOutput.mode === 'num')) {
        addHistory(q);
        if (!currentSearchOutput.isSegmented && currentSearchOutput.results.length > 0) {
          recordStudiedWord(currentSearchOutput.results[0]);
        } else if (currentSearchOutput.isSegmented && Array.isArray(currentSearchOutput.tokens) && currentSearchOutput.tokens.length === 1 && currentSearchOutput.tokens[0].bestEntry) {
          recordStudiedWord(currentSearchOutput.tokens[0].bestEntry);
        }
      }

      if (currentTab !== 'search') {
        switchTab('search');
      } else {
        renderCurrentView();
      }
    }

    function isQuizLocked() {
      return Boolean(
        currentTab === 'quiz' &&
        isDbReady &&
        activeQuizState &&
        !activeQuizState.completed &&
        Array.isArray(activeQuizState.questions) &&
        activeQuizState.questions.length > 0
      );
    }

    function syncQuizLockClass() {
      document.body.classList.toggle('quiz-locked', isQuizLocked());
    }

    function goHomeSearch() {
      if (isQuizLocked()) return;
      closeDetail();
      if (searchInput.value) {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        currentSearchOutput = { mode: 'empty', results: [], note: '' };
        resultCountEl.style.display = 'none';
      }
      switchTab('search');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function switchTab(tab) {
      if (tab !== 'quiz' && isQuizLocked()) return;
      closeDetail();
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
      });
      renderCurrentView();
    }


    // ===== 每日精選（首頁，未搜尋時顯示）=====
    // 詞用「表記」指定；同形異讀時寫成「表記|讀音」。核心主題優先，穿插主題搭配。
    const DAILY_CORE = [
      ['滑雪', ['スキー', 'スノーボード', 'スキー場', 'ゲレンデ', 'リフト', 'ゴンドラ', 'ゴーグル', 'ヘルメット', '初心者', '上級者', 'コース', 'ロープウェイ', 'パトロール', 'ワックス', 'ターン', 'ボード']],
      ['雪況', ['雪', '粉雪', '吹雪', '雪崩', '圧雪', '新雪', '積雪', '雪かき', '雪だるま', '雪景色', '雪原', '氷', '凍結', '霜', '雪解け', '大雪', '豪雪', '雪国']],
      ['北海道', ['北海道', '札幌', '函館', '流氷', '北国', '雪まつり', '昆布', '鮭', '牧場', '酪農', '湿原', '乳製品', '毛蟹', '鱈', 'ラベンダー']],
      ['冬天', ['冬', '真冬', '寒い', '寒さ', '冷たい', '防寒', '厚着', 'マフラー', 'コート', '手袋', '暖房', '炬燵', 'ストーブ', '懐炉', '暖かい', '凍える', '冬休み', '寒波']],
      ['天氣', ['天気', '天気予報', '晴れ', '曇り', '雨', '風|かぜ', '気温', '湿度', '台風', '霧', '雷', '快晴', '暴風', '気象', '傘', '予報']],
      ['溫泉', ['温泉', '露天風呂', '湯', '湯船', '源泉', '大浴場', '貸切風呂', '浴衣', '足湯', '湯治', '湯上がり', '混浴', '入浴', '効能', '硫黄']],
      ['風呂', ['風呂', 'お風呂', '銭湯', '浴室', '脱衣所', '洗い場', 'シャワー', '石鹸', 'シャンプー', 'タオル', '湯加減', '風呂上がり', '浴槽']],
      ['住宿', ['宿', '宿泊', 'ホテル', '旅館', '民宿', 'チェックイン', 'チェックアウト', '予約', '部屋', '鍵', '朝食', '素泊まり', 'フロント', '乾燥室', '荷物', '泊まる', '連泊', 'キャンセル', '禁煙']],
      ['交通', ['空港', '電車', '新幹線', 'バス', '駅', '切符', '乗り換え', '時刻表', '運行', '運休', '遅延', '送迎', 'タクシー', '改札', 'プラットホーム', '特急', '路線', 'レンタカー', '渋滞']],
      ['語言學校', ['語学', '授業', '先生', '生徒', '宿題', '試験', '教科書', '文法', '単語', '漢字', '留学', '留学生', '発音', '会話', '復習', '予習', '日本語', '学期', 'クラス', '出席', '欠席', '辞書']],
      ['學習', ['勉強', '学ぶ', '習う', '覚える', '暗記', '練習', '理解', '目標', '努力', '集中', '質問', '答え', '間違い', '上達', '継続', '習慣', '計画']],
      ['健身', ['筋トレ', '運動', '体力', '筋肉', '腹筋', '腕立て伏せ', 'スクワット', 'ダイエット', '有酸素運動', 'ストレッチ', '体重', '持久力', '鍛える', '汗', '走る', 'ウォーキング', 'ジョギング', 'プロテイン']],
      ['健身房', ['ジム', 'トレーナー', 'ダンベル', 'バーベル', 'ランニングマシン', 'ベンチプレス', '会員', '更衣室', 'マシン', 'ロッカー', '器具', '入会', '退会', 'ウェイト']],
      ['飲食', ['食事', '昼食', '夕食', '飲み物', 'お茶', 'ご飯', 'お菜', '注文', 'メニュー', '美味しい', '辛い', '甘い', '満腹', 'お腹', '食べる', '飲む', '乾杯', '割り勘', '会計', '定食', '弁当', '食べ放題', '飲み放題']],
      ['日本美食', ['寿司', '刺身', '天ぷら', '饂飩', '蕎麦', '味噌汁', '納豆', '焼き鳥', 'お好み焼き', 'たこ焼き', '豚カツ', '蟹', '海鮮', '丼', '味噌ラーメン', 'スープカレー', '親子丼', '焼肉', '餃子', '和菓子', '抹茶', '日本酒', '懐石', '居酒屋']]
    ];
    const DAILY_SUPP = [
      ['日常實用', ['有難う', '済みません', '大丈夫', 'お願い', '幾ら', '何処', '助けて', '手伝う', '無料', '割引', '領収書', '現金', 'クレジットカード', '両替', 'トイレ', '迷子', '落とし物', '忘れ物']],
      ['旅遊', ['旅行', '観光', '観光客', '地図', 'パスポート', 'お土産', '免税', '見どころ', '名所', '予定', '出発', '到着', '案内', '入場料', '写真', 'スーツケース']],
      ['健康與身體', ['体', '頭', '目', '耳', '鼻', '口', '喉', '肩', '腰', '腕', '足', '膝', '胃', '風邪', '熱', '頭痛', '薬', '病院', '痛い', '怪我', '疲れる', '体調']],
      ['日本文化', ['文化', '伝統', '着物', '茶道', '華道', '祭り', '花火', '相撲', '歌舞伎', '俳句', '和食', '畳|たたみ', '四季', '桜', '紅葉']],
      ['寺廟神社', ['神社', '寺', '鳥居', '参拝', 'お参り', '賽銭', '御神籤', '神様', '仏', '住職', '神主', '巫女', '本殿', '絵馬', 'お守り', '手水舎', '境内', '参道']],
      ['御朱印', ['御朱印', '御朱印帳', '朱印', '納経', '巡礼', '神社仏閣', '参拝', '墨書き', '書き置き']]
    ];
    const DAILY_KEY = 'yukiyosei_daily_v2';
    const DAILY_TOTAL = 6;
    const DAILY_CORE_N = 4;
    let dailyThemesCache = null;

    // 把主題詞表對應成詞庫詞條（優先選「主要表記完全相同」、其次常用、再其次義項多者）
    function resolveDailyThemes() {
      if (dailyThemesCache) return dailyThemesCache;
      const wanted = new Map();   // 表記 -> Set(讀音限制，空字串＝不限)
      const all = [['core', DAILY_CORE], ['supp', DAILY_SUPP]];
      all.forEach(([, groups]) => groups.forEach(([, words]) => words.forEach(item => {
        const [w, r] = item.split('|');
        if (!wanted.has(w)) wanted.set(w, new Set());
        wanted.get(w).add(r || '');
      })));
      const best = new Map();     // "w|r" -> { e, k }
      const scoreOf = (e, w) => {
        if (e[0][0] === w) return 3;
        if (e[0].length === 0 && e[1].includes(w)) return 3;
        if (e[0].includes(w)) return 1.5;
        if (e[1][0] === w) return 1;
        return 0;
      };
      for (let i = 0; i < dictData.length; i++) {
        const e = dictData[i];
        const forms = new Set(e[0].concat(e[1]));
        forms.forEach(w => {
          const rs = wanted.get(w);
          if (!rs) return;
          const sc = scoreOf(e, w);
          if (!sc) return;
          rs.forEach(r => {
            if (r && !e[1].includes(r)) return;
            const key = w + '|' + r;
            const k = [sc, e[2], e[3].length];
            const cur = best.get(key);
            if (!cur || k[0] > cur.k[0] || (k[0] === cur.k[0] && (k[1] > cur.k[1] || (k[1] === cur.k[1] && k[2] > cur.k[2])))) {
              best.set(key, { e, k });
            }
          });
        });
      }
      const used = new Set();
      const build = (group, groups) => groups.map(([name, words]) => {
        const entries = [];
        words.forEach(item => {
          const [w, r] = item.split('|');
          const hit = best.get(w + '|' + (r || ''));
          if (!hit) return;
          const id = getEntryId(hit.e);
          if (used.has(id)) return;        // 跨主題重複的詞只收一次
          used.add(id);
          entries.push(hit.e);
        });
        return { name, group, entries };
      }).filter(t => t.entries.length > 0);
      dailyThemesCache = [...build('core', DAILY_CORE), ...build('supp', DAILY_SUPP)];
      return dailyThemesCache;
    }

    function localDateStr(d) {
      d = d || new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function shuffled(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }

    // 第二階段用的「全站常用詞庫」：常用詞、排除助詞／接頭接尾辭／助數詞等文法性詞條與單一假名
    const DAILY_SKIP_POS = new Set(['prt', 'suf', 'pref', 'n-suf', 'n-pref', 'aux', 'aux-v', 'cop', 'ctr', 'conj', 'int', 'num', 'pn', 'adj-f']);
    let dailyCommonCache = null;
    function getCommonPool() {
      if (dailyCommonCache) return dailyCommonCache;
      const byId = new Map();
      for (let i = 0; i < dictData.length; i++) {
        const e = dictData[i];
        if (!e[2] || !e[3] || !e[3].length || !e[3][0].g || !e[3][0].g.length) continue;
        const pos = e[3][0].p || [];
        if (pos.length && pos.every(p => DAILY_SKIP_POS.has(p))) continue;
        const main = e[0][0] || e[1][0] || '';
        if (!e[1][0] || (!e[0].length && main.length < 2)) continue;
        const id = getEntryId(e);
        if (!byId.has(id)) byId.set(id, e);
      }
      dailyCommonCache = byId;
      return byId;
    }

    // 每日精選狀態（localStorage）：
    //   date       最後一次抽選的日期（日期變了就自動換一組）
    //   picks      目前這組的詞條 id
    //   seenTheme  第一階段已出現過的主題單字
    //   seenCommon 第二階段已出現過的常用新詞
    function loadDailyState() {
      try {
        const s = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null');
        if (s && Array.isArray(s.picks)) {
          return {
            date: s.date || '',
            picks: s.picks,
            seenTheme: Array.isArray(s.seenTheme) ? s.seenTheme : [],
            seenCommon: Array.isArray(s.seenCommon) ? s.seenCommon : []
          };
        }
      } catch (e) {}
      return { date: '', picks: [], seenTheme: [], seenCommon: [] };
    }
    function saveDailyState(state) {
      try { localStorage.setItem(DAILY_KEY, JSON.stringify(state)); } catch (e) {}
    }

    // 從候選詞中盡量讓每個主題各取一個，不夠再從剩下的補滿
    function pickSpread(candidatesByTheme, n) {
      const got = [];
      const gotIds = new Set();
      for (const list of shuffled(candidatesByTheme)) {
        if (got.length >= n) break;
        const c = list.filter(e => !gotIds.has(getEntryId(e)));
        if (!c.length) continue;
        const e = c[Math.floor(Math.random() * c.length)];
        got.push(e); gotIds.add(getEntryId(e));
      }
      if (got.length < n) {
        for (const e of shuffled(candidatesByTheme.flat())) {
          if (got.length >= n) break;
          const id = getEntryId(e);
          if (gotIds.has(id)) continue;
          got.push(e); gotIds.add(id);
        }
      }
      return got;
    }

    // 抽一組新的單字（兩階段）並寫回 state
    function drawDaily(state) {
      const themes = resolveDailyThemes();
      const themeById = new Map();
      themes.forEach(t => t.entries.forEach(e => themeById.set(getEntryId(e), e)));
      const seenTheme = new Set(state.seenTheme.filter(id => themeById.has(id)));
      const seenCommon = new Set(state.seenCommon);
      const unseenOf = (group) => themes
        .filter(t => t.group === group)
        .map(t => t.entries.filter(e => !seenTheme.has(getEntryId(e))))
        .filter(list => list.length);

      const picks = [];
      const pickedIds = new Set();
      const add = (e) => { const id = getEntryId(e); if (!pickedIds.has(id)) { pickedIds.add(id); picks.push(e); return true; } return false; };

      const unseenCore = unseenOf('core');
      const unseenSupp = unseenOf('supp');
      const themeLeft = unseenCore.flat().length + unseenSupp.flat().length;

      if (themeLeft > 0) {
        // ── 第一階段：只抽主題內「還沒出現過」的單字（核心優先 4 個，搭配 2 個，不足互相補）
        pickSpread(unseenCore, DAILY_CORE_N).forEach(add);
        pickSpread(unseenSupp, DAILY_TOTAL - DAILY_CORE_N).forEach(add);
        if (picks.length < DAILY_TOTAL) {
          const rest = [...unseenCore, ...unseenSupp].map(l => l.filter(e => !pickedIds.has(getEntryId(e))));
          pickSpread(rest, DAILY_TOTAL - picks.length).forEach(add);
        }
        picks.forEach(e => seenTheme.add(getEntryId(e)));
      }

      if (picks.length < DAILY_TOTAL) {
        // ── 第二階段（含第一階段最後一批的補位）：全站常用詞庫抽「未出現過」的新詞，
        //    再穿插 1～2 個原主題單字；主題單字只在已經全數輪完後才穿插。
        const stage2 = themeLeft === 0;
        const nTheme = stage2 ? (Math.random() < 0.5 ? 1 : 2) : 0;
        const nCommon = DAILY_TOTAL - picks.length - nTheme;

        const pool = getCommonPool();
        let fresh = [...pool.keys()].filter(id => !seenCommon.has(id) && !themeById.has(id) && !pickedIds.has(id));
        if (fresh.length < nCommon) {          // 常用詞庫也輪完一輪 → 重新開始新的一輪
          seenCommon.clear();
          fresh = [...pool.keys()].filter(id => !themeById.has(id) && !pickedIds.has(id));
        }
        shuffled(fresh).slice(0, nCommon).forEach(id => { add(pool.get(id)); seenCommon.add(id); });

        if (nTheme) {
          const prev = new Set(state.picks);   // 避免和上一組重複
          let cand = [...themeById.values()].filter(e => !prev.has(getEntryId(e)) && !pickedIds.has(getEntryId(e)));
          if (!cand.length) cand = [...themeById.values()].filter(e => !pickedIds.has(getEntryId(e)));
          shuffled(cand).slice(0, nTheme).forEach(add);
        }
      }

      const result = shuffled(picks);
      return {
        entries: result,
        state: {
          date: localDateStr(),
          picks: result.map(getEntryId),
          seenTheme: [...seenTheme],
          seenCommon: [...seenCommon]
        }
      };
    }

    // 取得目前這組每日精選：同一天沿用同一組；跨日或 force=true（換一批）才重新抽
    function getDailyPicks(force) {
      const state = loadDailyState();
      const today = localDateStr();
      if (!force && state.date === today && state.picks.length) {
        const themeById = new Map();
        resolveDailyThemes().forEach(t => t.entries.forEach(e => themeById.set(getEntryId(e), e)));
        const pool = getCommonPool();
        const cached = state.picks.map(id => themeById.get(id) || pool.get(id)).filter(Boolean);
        if (cached.length >= 5) return cached;
      }
      const drawn = drawDaily(state);
      saveDailyState(drawn.state);
      return drawn.entries;
    }

    // 每日精選的精簡卡片：<ruby> 平假名讀音＋簡短字義＋發音／收藏，不顯示主題標籤
    function renderDailyCards(entries) {
      const list = document.createElement('div');
      list.className = 'word-list daily-list';
      entries.forEach((entry) => {
        const [kanjis, kanas, , senses, zhs] = entry;
        const word = kanjis.length > 0 ? kanjis[0] : kanas[0];
        const reading = kanas[0] || '';
        const readingHira = toHiragana(reading);
        const wordHtml = kanjis.length > 0 && readingHira
          ? `<ruby>${escapeHtml(word)}<rt>${escapeHtml(readingHira)}</rt></ruby>`
          : escapeHtml(word);
        const gloss = (zhs && zhs.length > 0)
          ? zhs.slice(0, 3).join('、')
          : (senses[0] ? senses[0].g.slice(0, 2).join('; ') : '');
        const fav = isFavorite(entry);

        const card = document.createElement('article');
        card.className = 'word-card daily-card clickable';
        card.innerHTML = `
          <div class="daily-main">
            <div class="daily-word">${wordHtml}</div>
            <div class="daily-gloss">${escapeHtml(gloss)}</div>
          </div>
          <div class="card-actions">
            <button class="icon-btn speak-btn" title="日語發音" data-speak="${escapeHtml(reading || word)}">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            </button>
            <button class="icon-btn copy-btn" type="button" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(word)}">${COPY_SVG}</button>
            <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" title="${fav ? '取消收藏' : '加入收藏'}">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            </button>
          </div>
        `;
        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openDetail(entry, null);
        });
        card.querySelector('.fav-btn').addEventListener('click', () => toggleFavorite(entry));
        card.querySelector('[data-speak]').addEventListener('click', (e) => speakJapanese(e.currentTarget.getAttribute('data-speak')));
        card.querySelector('[data-copy]').addEventListener('click', (e) => {
          e.stopPropagation();
          copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
        });
        list.appendChild(card);
      });
      return list;
    }

    function renderDailySection() {
      const wrap = document.createElement('section');
      wrap.className = 'daily-section';
      wrap.innerHTML = `
        <div class="daily-head">
          <h2 class="daily-title">每日精選</h2>
          <button class="daily-refresh" id="dailyRefresh" type="button">↻ 換一批</button>
        </div>
      `;
      wrap.appendChild(renderDailyCards(getDailyPicks(false)));
      wrap.querySelector('#dailyRefresh').addEventListener('click', () => {
        getDailyPicks(true);
        renderCurrentView();
      });
      return wrap;
    }

    function renderCurrentView() {
      if (currentTab === 'quiz' && isDbReady && (!activeQuizState || activeQuizState.date !== localDateStr())) {
        activeQuizState = getOrCreateDailyQuiz(false);
      }
      syncQuizLockClass();
      strategyArea.innerHTML = '';
      mainContent.innerHTML = '';

      const activeSegOut = (currentTab === 'search' && searchInput.value.trim() && currentSearchOutput.isSegmented)
        ? currentSearchOutput
        : null;
      renderSegmentBar(activeSegOut);

      if (currentDetail) {
        mainContent.appendChild(renderDetailPage(currentDetail, currentDetailInf));
        return;
      }

      if (currentTab === 'search') {
        if (!isDbReady) return;

        if (!searchInput.value.trim()) {
          // 未搜尋：不顯示提示框與結果計數，只顯示「每日精選」
          resultCountEl.style.display = 'none';
          strategyArea.innerHTML = '';
          mainContent.appendChild(renderDailySection());
          return;
        }

        const out = currentSearchOutput;

        if (out.isSegmented) {
          if (out.segViewMode === 'overview') {
            const isAiOn = Boolean(out.aiSeg && out.aiSeg.state === 'done' && out.aiSeg.active);
            const aiErrNote = (out.aiSeg && out.aiSeg.state === 'error')
              ? `<div class="seg-ai-note">AI 拆句暫時無法連線（已顯示本地離線斷詞）：${escapeHtml(out.aiSeg.error || '')}</div>`
              : '';
            strategyArea.innerHTML = `
              <div class="strategy-banner">
                <span>已斷詞為 ${out.tokens.length} 個詞彙（點擊卡片看詳細，點擊上方斷詞膠囊查同音詞）</span>
                <span class="mode-tag mode-jp">${isAiOn ? 'AI 語意拆解' : '逐詞對照一覽'}</span>
              </div>
              ${aiErrNote}
            `;
            const aiSentenceCard = renderSentenceAiTranslationCard(out);
            if (aiSentenceCard) mainContent.appendChild(aiSentenceCard);
            mainContent.appendChild(renderSegmentOverview(out));
            return;
          }

          if (out.segViewMode === 'exactFull') {
            strategyArea.innerHTML = `
              <div class="strategy-banner">
                <span>完整比對「${escapeHtml(out.rawQuery)}」的詞庫收錄詞條</span>
                <span class="mode-tag mode-jp">完整比對</span>
              </div>
            `;
            const backToSegBtn = document.createElement('button');
            backToSegBtn.type = 'button';
            backToSegBtn.className = 'alt-link';
            backToSegBtn.textContent = `‹ 返回「${out.rawQuery}」逐詞對照一覽`;
            backToSegBtn.addEventListener('click', () => {
              currentSearchOutput.segViewMode = 'overview';
              currentSearchOutput.activeSegmentIndex = -1;
              resultCountEl.textContent = out.tokens.length;
              renderCurrentView();
            });
            strategyArea.appendChild(backToSegBtn);
            const rendered = renderWordCards(out.exactFullMatches);
            if (typeof rendered === 'string') mainContent.innerHTML += rendered;
            else mainContent.appendChild(rendered);
            return;
          }

          const tok = out.tokens[out.activeSegmentIndex] || out.tokens[0];
          const tokOut = tok.tokenRes;
          strategyArea.innerHTML = `
            <div class="strategy-banner">
              <span>${escapeHtml(tokOut.note)}（共 ${tokOut.results.length} 筆）</span>
              <span class="mode-tag mode-jp">斷詞模式</span>
            </div>
          `;
          const rendered = renderWordCards(tokOut.results, tokOut.inflections);
          if (typeof rendered === 'string') mainContent.innerHTML += rendered;
          else mainContent.appendChild(rendered);
          return;
        }

        if (out.translate) {
          const t = out.translate;
          const lang = t.state === 'done' ? `${LANG_LABEL[t.from]} → ${LANG_LABEL[t.to]}` : '線上翻譯';
          strategyArea.innerHTML = `
            <div class="strategy-banner">
              <span>詞庫查無「${escapeHtml(t.query)}」，改用線上翻譯</span>
              <span class="mode-tag mode-zh">翻譯 ${escapeHtml(lang)}</span>
            </div>
          `;
          mainContent.appendChild(renderTranslateBlock(t));
          return;
        }

        const modeClass = out.mode === 'jp' || out.mode === 'num' || out.mode === 'wild' ? 'mode-jp'
                        : out.mode === 'en' ? 'mode-en' : 'mode-zh';
        strategyArea.innerHTML = `
          <div class="strategy-banner">
            <span>${escapeHtml(out.note)}</span>
            <span class="mode-tag ${modeClass}">${escapeHtml(out.badge || '')}</span>
          </div>
        `;
        if (out.alt) {
          const btn = document.createElement('button');
          btn.className = 'alt-link';
          btn.textContent = out.alt.label;
          btn.addEventListener('click', () => {
            const q = searchInput.value.trim();
            currentSearchOutput = executeSmartSearch(q, out.alt.opts);
            resultCountEl.textContent = currentSearchOutput.results.length;
            renderCurrentView();
          });
          strategyArea.appendChild(btn);
        }
        if (out.mode === 'num' && out.numberInfo) {
          mainContent.appendChild(renderNumberCard(out.numberInfo));
        }
        if (out.results.length > 0 || out.mode !== 'num') {
          const rendered = renderWordCards(out.results, out.inflections);
          if (typeof rendered === 'string') mainContent.innerHTML += rendered;
          else mainContent.appendChild(rendered);
        }
      } else if (currentTab === 'quiz') {
        if (!isDbReady) return;
        mainContent.appendChild(renderDailyQuizPage());
      } else if (currentTab === 'favorites') {
        if (favorites.length === 0) {
          const emptyFav = document.createElement('div');
          emptyFav.className = 'empty-state';
          emptyFav.innerHTML = `<strong>尚未收藏任何單字</strong><p>點擊單字卡片右上角的愛心圖示，即可將單字加入個人單字本。</p>`;
          mainContent.appendChild(emptyFav);
        } else {
          mainContent.appendChild(renderWordCards(favorites));
        }
        if (isDbReady) {
          mainContent.appendChild(renderWrongBankSection());
        }
      } else if (currentTab === 'history') {
        if (historyList.length === 0) {
          mainContent.innerHTML = `<div class="empty-state"><strong>尚無搜尋紀錄</strong><p>您查詢過的單字會自動保存在這裡，方便隨時回顧。</p></div>`;
        } else {
          const wrap = document.createElement('div');
          wrap.innerHTML = `
            <div class="history-header">
              <span style="font-size:0.85rem;color:var(--text-secondary);">點擊紀錄可重新查詢</span>
              <button class="text-btn" id="clearHistBtn">清除全部歷史</button>
            </div>
            <div class="history-grid">
              ${historyList.map(h => `
                <div class="history-item" data-q="${escapeHtml(h.q)}">
                  <span>${escapeHtml(h.q)}</span>
                  <span class="history-time">${escapeHtml(h.time)}</span>
                </div>
              `).join('')}
            </div>
          `;
          wrap.querySelector('#clearHistBtn').addEventListener('click', clearHistory);
          wrap.querySelectorAll('.history-item').forEach(el => {
            el.addEventListener('click', () => {
              const q = el.getAttribute('data-q');
              searchInput.value = q;
              performSearch(q, false);
            });
          });
          mainContent.appendChild(wrap);
        }
      }
    }

    let debounceTimer = null;
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      clearBtn.style.display = val ? 'flex' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        performSearch(val, true);
      }, 280);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        performSearch(searchInput.value, true);
      }
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      performSearch('', false);
      searchInput.focus();
    });

    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-q');
        searchInput.value = q;
        performSearch(q, true);
      });
    });

    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });


    // =========================================================================
    // ===== 每日小考（Daily Quiz）：學習足跡、錯題庫、動態出題、容錯比對、動效 =====
    // =========================================================================

    const QUIZ_PRAISE_PHRASES = [
      'すごい！大正解！',
      'すごい！正解だよ！',
      'やったね！大正解！',
      'さすが！正解！'
    ];

    function offsetDateStr(daysOffset) {
      const d = new Date();
      d.setDate(d.getDate() + daysOffset);
      return localDateStr(d);
    }

    // 紀錄每日學習足跡（YYYY-MM-DD，同日重複單字不重複累計）
    function recordStudiedWord(entry) {
      if (!entry) return;
      const id = getEntryId(entry);
      if (!id) return;
      const today = localDateStr();
      const dayRec = studyLogStore.days[today] || { wordIds: [], updatedAt: 0 };
      if (dayRec.wordIds.includes(id)) return;
      const now = Date.now();
      dayRec.wordIds.push(id);
      dayRec.updatedAt = now;
      studyLogStore.days[today] = dayRec;
      studyLogStore.updatedAt = now;

      const keys = Object.keys(studyLogStore.days).sort();
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => { delete studyLogStore.days[k]; });
      }
      safeWriteJson(STORAGE_KEYS.studyLog, studyLogStore);
      scheduleCloudSyncPush();
    }

    // 錯題庫寫入／軟刪除移出（附帶 updatedAt 以便跨裝置雙向同步）
    function addWordToWrongBank(entry) {
      const id = getEntryId(entry);
      if (!id) return;
      const now = Date.now();
      const prev = wrongBankStore.items[id];
      wrongBankStore.items[id] = {
        id,
        addedAt: (prev && !prev.deleted) ? prev.addedAt : now,
        updatedAt: now,
        wrongCount: (prev && !prev.deleted) ? (prev.wrongCount || 1) + 1 : 1,
        deleted: false
      };
      wrongBankStore.updatedAt = now;
      enforceWrongBankLimit();
      safeWriteJson(STORAGE_KEYS.wrongBank, wrongBankStore);
      scheduleCloudSyncPush();
    }

    function removeWordFromWrongBank(entry) {
      const id = getEntryId(entry);
      if (!id || !wrongBankStore.items[id] || wrongBankStore.items[id].deleted) return;
      const now = Date.now();
      wrongBankStore.items[id] = {
        ...wrongBankStore.items[id],
        updatedAt: now,
        deleted: true
      };
      wrongBankStore.updatedAt = now;
      safeWriteJson(STORAGE_KEYS.wrongBank, wrongBankStore);
      scheduleCloudSyncPush();
    }

    const SIMP_ONLY_CHAR_SET = (() => {
      const s = new Set();
      TRAD_SIMP_PAIRS.forEach(pair => {
        if (pair.length % 2 === 0) {
          const half = pair.length / 2;
          for (let i = 0; i < half; i++) {
            if (pair[i] !== pair[i + half]) s.add(pair[i + half]);
          }
        }
      });
      return s;
    })();

    const TRAD_ONLY_CHAR_SET = (() => {
      const s = new Set();
      TRAD_SIMP_PAIRS.forEach(pair => {
        if (pair.length % 2 === 0) {
          const half = pair.length / 2;
          for (let i = 0; i < half; i++) {
            if (pair[i] !== pair[i + half]) s.add(pair[i]);
          }
        }
      });
      return s;
    })();

    function scoreTraditionalChinese(str) {
      let score = 0;
      for (const ch of String(str || '')) {
        if (TRAD_ONLY_CHAR_SET.has(ch)) score += 2;
        if (SIMP_ONLY_CHAR_SET.has(ch)) score -= 3;
      }
      return score;
    }

    function getCleanZhList(entry) {
      const zhs = (entry && entry[4]) || [];
      const filtered = zhs.filter(z => z && !/[㐀-䶿]/.test(z));
      if (filtered.length <= 1) return filtered;
      return filtered
        .map((text, idx) => ({ text, idx, score: scoreTraditionalChinese(text) }))
        .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
        .map(item => item.text);
    }

    function hasValidQuizZh(entry) {
      return getCleanZhList(entry).length > 0;
    }

    function getEntryPosLabels(entry) {
      const senses = (entry && entry[3]) || [];
      const seen = new Set();
      const labels = [];
      senses.forEach(sn => {
        (sn.p || []).forEach(tag => {
          const lb = posLabel(tag);
          if (lb && !seen.has(lb)) {
            seen.add(lb);
            labels.push(lb);
          }
        });
      });
      return labels.slice(0, 3);
    }

    function assignQuestionMode(entry) {
      const hasZh = getCleanZhList(entry).length > 0;
      if (!hasZh) return 'jp2zh';
      return Math.random() < 0.5 ? 'jp2zh' : 'zh2jp';
    }

    // 動態出題生成器：每日最多 10 題；以前一日搜尋／查看紀錄為主，超過 10 題的未問單字保留至隔日接續出題
    const DAILY_QUIZ_MAX = 10;

    function loadQuizCarryover() {
      const raw = safeReadJson(STORAGE_KEYS.quizCarryover, null);
      if (raw && Array.isArray(raw.wordIds)) {
        return {
          wordIds: [...new Set(raw.wordIds.filter(Boolean))],
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
        };
      }
      return { wordIds: [], updatedAt: 0 };
    }

    function saveQuizCarryover(wordIds) {
      const unique = [...new Set((wordIds || []).filter(Boolean))];
      if (unique.length === 0) {
        try { localStorage.removeItem(STORAGE_KEYS.quizCarryover); } catch (e) {}
      } else {
        safeWriteJson(STORAGE_KEYS.quizCarryover, {
          wordIds: unique,
          updatedAt: Date.now()
        });
      }
    }

    function getOrCreateDailyQuiz(forceNewRound = false) {
      const today = localDateStr();
      if (!forceNewRound) {
        const saved = safeReadJson(STORAGE_KEYS.dailyQuiz, null);
        if (saved && saved.date === today && saved.completed === true) {
          return {
            version: 1,
            date: today,
            updatedAt: saved.updatedAt || Date.now(),
            completed: true,
            correctCount: typeof saved.correctCount === 'number' ? saved.correctCount : 0,
            totalCount: typeof saved.totalCount === 'number' ? saved.totalCount : 0,
            currentIndex: 0,
            questions: [],
            remainingCarryoverIds: []
          };
        }
      }

      const yesterday = offsetDateStr(-1);
      const yRec = studyLogStore.days[yesterday];
      const yUniqueIds = yRec && Array.isArray(yRec.wordIds) ? [...new Set(yRec.wordIds)] : [];
      const carryover = loadQuizCarryover();

      // 優先順序：1) 前一日搜尋／查看紀錄（為主） → 2) 之前超過 10 題留存下來的未問單字
      const primaryPoolIds = [];
      const seenPool = new Set();
      [...yUniqueIds, ...carryover.wordIds].forEach(id => {
        if (seenPool.has(id)) return;
        const e = getEntryById(id);
        if (e && hasValidQuizZh(e)) {
          seenPool.add(id);
          primaryPoolIds.push(id);
        }
      });

      const wrongIds = Object.keys(wrongBankStore.items).filter(
        id => wrongBankStore.items[id] && !wrongBankStore.items[id].deleted
      );
      const picked = [];
      const pickedIds = new Set();
      const pushItem = (entry, source) => {
        if (!entry || !hasValidQuizZh(entry)) return false;
        const id = getEntryId(entry);
        if (!id || pickedIds.has(id) || picked.length >= DAILY_QUIZ_MAX) return false;
        pickedIds.add(id);
        picked.push({
          id,
          mode: assignQuestionMode(entry),
          source,
          status: 'pending',
          userAnswer: ''
        });
        return true;
      };

      let sourceType = 'fallback';
      let remainingCarryoverIds = [];

      if (primaryPoolIds.length > 0) {
        sourceType = 'yesterday';
        // 若昨日＋留存超過 10 題：本回最多取 10 題（若錯題庫有未包含的錯題且還有空位，最多穿插 1～2 題）
        const extraWrongWanted = primaryPoolIds.length < DAILY_QUIZ_MAX
          ? Math.min(DAILY_QUIZ_MAX - primaryPoolIds.length, Math.random() < 0.5 ? 1 : 2)
          : 0;
        const mainQuota = DAILY_QUIZ_MAX - extraWrongWanted;

        const todayPrimaryIds = primaryPoolIds.slice(0, mainQuota);
        remainingCarryoverIds = primaryPoolIds.slice(mainQuota);

        todayPrimaryIds.forEach(id => pushItem(getEntryById(id), 'yesterday'));

        if (extraWrongWanted > 0) {
          const wrongCandidates = shuffled(wrongIds)
            .filter(id => !pickedIds.has(id) && !remainingCarryoverIds.includes(id))
            .map(id => getEntryById(id))
            .filter(Boolean);
          wrongCandidates.slice(0, extraWrongWanted).forEach(e => pushItem(e, 'wrong'));
        }

        // 若穿插錯題後還有空位（例如錯題不足），繼續從剩餘留存題補滿到 10 題
        if (picked.length < DAILY_QUIZ_MAX && remainingCarryoverIds.length > 0) {
          const stillLeft = [];
          remainingCarryoverIds.forEach(id => {
            if (picked.length < DAILY_QUIZ_MAX) {
              pushItem(getEntryById(id), 'yesterday');
            } else {
              stillLeft.push(id);
            }
          });
          remainingCarryoverIds = stillLeft;
        }
      } else {
        // 無昨日紀錄也無留存題：固定出 5 題（錯題庫 → 收藏清單 → 內建精選主題詞庫）
        const TARGET_N = 5;
        shuffled(wrongIds)
          .map(id => getEntryById(id))
          .filter(Boolean)
          .slice(0, TARGET_N)
          .forEach(e => pushItem(e, 'wrong'));

        if (picked.length < TARGET_N) {
          shuffled(favorites).forEach(e => {
            if (picked.length < TARGET_N) pushItem(e, 'fav');
          });
        }

        if (picked.length < TARGET_N) {
          const themeEntries = resolveDailyThemes().flatMap(t => t.entries);
          shuffled(themeEntries).forEach(e => {
            if (picked.length < TARGET_N) pushItem(e, 'theme');
          });
        }

        if (picked.length < TARGET_N) {
          const commonEntries = [...getCommonPool().values()];
          shuffled(commonEntries).forEach(e => {
            if (picked.length < TARGET_N) pushItem(e, 'theme');
          });
        }
      }

      // 均衡分配題型（確保日翻中與中翻日各佔約一半，避免連續隨機偏向單一題型）
      const mixed = shuffled(picked);
      if (mixed.length > 0) {
        const half = Math.floor(mixed.length / 2);
        const jp2zhCount = mixed.length % 2 === 0
          ? half
          : (Math.random() < 0.5 ? half : half + 1);
        const modes = shuffled([
          ...Array(jp2zhCount).fill('jp2zh'),
          ...Array(mixed.length - jp2zhCount).fill('zh2jp')
        ]);
        mixed.forEach((q, i) => {
          q.mode = modes[i];
        });
      }

      return {
        version: 1,
        date: today,
        updatedAt: Date.now(),
        completed: false,
        sourceType,
        currentIndex: 0,
        questions: mixed,
        remainingCarryoverIds
      };
    }

    function saveDailyQuizCompletion(state) {
      const correctCount = state.questions.filter(q => q.status === 'correct').length;
      const totalCount = state.questions.length;
      state.completed = true;
      state.correctCount = correctCount;
      state.totalCount = totalCount;
      state.updatedAt = Date.now();
      if (state.sourceType === 'yesterday') {
        saveQuizCarryover(state.remainingCarryoverIds || []);
      }
      safeWriteJson(STORAGE_KEYS.dailyQuiz, {
        version: 1,
        date: state.date,
        updatedAt: state.updatedAt,
        completed: true,
        correctCount,
        totalCount
      });
      updateQuizPendingDot();
      scheduleCloudSyncPush();
    }

    function updateQuizPendingDot() {
      const dot = document.getElementById('quizPendingDot');
      if (!dot) return;
      const today = localDateStr();
      const saved = safeReadJson(STORAGE_KEYS.dailyQuiz, null);
      const isDoneToday = !!(saved && saved.date === today && saved.completed === true);
      dot.style.display = isDoneToday ? 'none' : '';
    }

    // 繁簡中文常用字對照表（確保日漢釋義比對兼容繁體與簡體中文）
    const TRAD_SIMP_PAIRS = [
      '學学','習习','語语','詞词','辭辞','書书','讀读','寫写','聽听','說说','話话','請请','謝谢',
      '車车','電电','駅站','站站','飛飞','機机','場场','船船','鐵铁','線线','路路','地圖地图',
      '買买','賣卖','錢钱','銀银','價价','貴贵','便便','免費免费','割引折扣','現金现金','領収書收据',
      '飲饮','食食','飯饭','麵面','湯汤','魚鱼','鳥鸟','肉肉','菜菜','菓果','茶茶','酒酒','燒烧','揚げ炸',
      '壽司寿司','拉麵拉面','味噌湯味噌汤','丼盖饭','便當便当','點心点心','甜點甜点','好吃美味',
      '雪雪','雲云','風风','雨雨','晴晴','陰阴','霧雾','雷雷','氣气','溫温','冷冷','熱热','暖暖','凍冻',
      '溫泉温泉','風呂浴池','湯船浴缸','旅館旅馆','飯店饭店','房間房间','鑰匙钥匙','預約预约','行李行李',
      '護照护照','簽證签证','觀光观光','旅遊旅游','風景风景','櫻花樱花','紅葉红叶','寺廟寺庙','繪馬绘马',
      '運動运动','健身健身','肌肉肌肉','體力体力','體重体重','練習练习','考試考试','問題问题','答案答案',
      '時間时间','時时','分分','秒秒','今天今日','明天明日','昨天昨日','星期周','週周','年年','月月','日日',
      '電話电话','電腦电脑','網路网络','手機手机','相機相机','照片照片','音樂音乐','電影电影','電視电视',
      '醫院医院','醫生医生','藥药','感冒感冒','發燒发烧','頭痛头痛','肚子腹','身體身体','眼睛眼','耳朵耳',
      '頭髮头发','臉脸','手手','腳脚','心心','愛爱','喜歡喜欢','討厭讨厌','高興高兴','快樂快乐','難過难过',
      '生氣生气','害怕害怕','擔心担心','安心安心','危險危险','安全安全','方便方便','麻煩麻烦','簡單简单',
      '困難困难','重要重要','特別特别','普通普通','一樣一样','不同不同','開始开始','結束结束','繼續继续',
      '準備准备','決定决定','選擇选择','幫助帮助','幫忙帮忙','照顧照顾','介紹介绍','說明说明','確認确认',
      '發現发现','發明发明','變化变化','發展发展','經驗经验','知識知识','文化文化','傳統传统','歷史历史',
      '經濟经济','政治政治','社會社会','環境环境','自然自然','動物动物','植物植物','花花','草草','樹树',
      '山山','川川','海海','河河','湖湖','島岛','國国','都市城市','鄉下乡下','公園公园','圖書館图书馆',
      '銀行银行','郵局邮局','警察警察','學校学校','老師老师','學生学生','同學同学','朋友朋友','家人家人',
      '父親父亲','母親母亲','哥哥兄','姊姊姐','弟弟弟','妹妹妹','丈夫丈夫','妻子妻子','孩子小孩','寶寶宝宝',
      '男男','女女','大人大人','老人老人','年輕年轻','漂亮美丽','帥氣帅气','可愛可爱','溫柔温柔','親切亲切',
      '認真认真','努力努力','聰明聪明','厲害厉害','糟糕糟糕','奇怪奇怪','安靜安静','熱鬧热闹','乾淨干净',
      '髒脏','新新','舊旧','長长','短短','高高','矮矮','胖胖','瘦瘦','強强','弱弱','快快','慢慢','早早','晚晚',
      '多多少','少少','大大小','小小','遠远','近近','左左','右右','前前','後后','裡里','外外','上上','下下',
      '紅红','藍蓝','綠绿','黃黄','白白','黑黑','灰灰','粉紅粉红','紫色紫色','金色金色','銀色银色',
      '門门','窗窗','桌子桌','椅子椅','床床','燈灯','鏡子镜子','傘伞','衣服衣','褲子裤子','鞋子鞋','帽子帽',
      '眼鏡眼镜','手錶手表','包包包','錢包钱包','毛巾毛巾','肥皂肥皂','牙刷牙刷','衛生紙卫生纸','垃圾垃圾',
      '開开','關关','進进','出出','來来','去去','回回','走走','跑跑','跳跳','站站','坐坐','睡睡','醒醒',
      '看观','見见','聞闻','嚐尝','摸摸','拿取','放放','給给','收收','借借','還还','送送','接接','找寻',
      '忘忘','記记','想思','知道知','懂理解','會能','做作','工作工作','休息休息','玩玩','唱唱','畫画'
    ];

    const TRAD_TO_SIMP_MAP = (() => {
      const m = new Map();
      TRAD_SIMP_PAIRS.forEach(pair => {
        if (pair.length === 2) {
          m.set(pair[0], pair[1]);
        } else if (pair.length % 2 === 0) {
          const half = pair.length / 2;
          for (let i = 0; i < half; i++) {
            m.set(pair[i], pair[i + half]);
          }
        }
      });
      return m;
    })();

    function normalizeChineseForCompare(str) {
      const cleaned = String(str || '')
        .toLowerCase()
        .replace(/[\s　・･·\-—_~〜～!！?？。．.「」『』【】《》〈〉"'’“”]/g, '');
      let out = '';
      for (const ch of cleaned) {
        out += TRAD_TO_SIMP_MAP.get(ch) || ch;
      }
      return out;
    }

    function stripParens(str) {
      let prev = String(str || '');
      let next = prev.replace(/（[^（）]*）|\([^()]*\)/g, '');
      while (next !== prev) {
        prev = next;
        next = prev.replace(/（[^（）]*）|\([^()]*\)/g, '');
      }
      return next;
    }

    // 日翻中容錯比對：濾除括號補充說明，依分號／頓號拆解，兼容繁簡中文與同義橋接
    function checkJp2ZhAnswer(userInput, entry) {
      const rawTrimmed = String(userInput || '').trim();
      const userNorm = normalizeChineseForCompare(rawTrimmed);
      if (!userNorm) return false;

      const zhs = getCleanZhList(entry);
      const candidates = [];

      zhs.forEach(raw => {
        const noParen = stripParens(raw);
        noParen.split(/[；;、／/，,｜|]+/).forEach(part => {
          const norm = normalizeChineseForCompare(part);
          if (norm) candidates.push(norm);
        });
      });

      if (candidates.includes(userNorm)) return true;

      // 同義詞容錯：透過 zhBridge 反向比對詞條中文釋義（或輸入中文）對應的英文核心釋義是否相符
      if (zhBridge && entry && Array.isArray(entry[3])) {
        const entryEnSet = new Set();
        for (const sn of entry[3]) {
          for (const g of (sn.g || [])) {
            const gClean = stripParens(g).toLowerCase().replace(/^to\s+/, '').trim();
            if (gClean) entryEnSet.add(gClean);
          }
        }

        const zhLookupKeys = new Set([rawTrimmed, userNorm, ...zhs]);
        for (const key of zhLookupKeys) {
          const bridgeHits = (key && zhBridge[key]) || [];
          for (const def of bridgeHits) {
            for (const p of def.split(';')) {
              const clean = stripParens(p).toLowerCase().replace(/^to\s+/, '').trim();
              if (clean && entryEnSet.has(clean)) return true;
            }
          }
        }
      }

      return false;
    }

    function normalizeJpForCompare(str) {
      return String(str || '')
        .trim()
        .replace(/[\s　・･·〜～~]/g, '');
    }

    // 中翻日容錯比對：符合「日文漢字寫法」或「平假名／片假名讀音」任一即算答對
    function checkZh2JpAnswer(userInput, entry) {
      const raw = normalizeJpForCompare(userInput);
      if (!raw) return false;
      const userHira = toHiragana(raw);
      const userKata = toKatakana(raw);

      const kanjis = (entry && entry[0]) || [];
      const kanas = (entry && entry[1]) || [];
      const accepted = new Set();

      kanjis.forEach(k => {
        const nk = normalizeJpForCompare(k);
        if (nk) {
          accepted.add(nk);
          accepted.add(toHiragana(nk));
          accepted.add(toKatakana(nk));
        }
      });

      kanas.forEach(r => {
        const nr = normalizeJpForCompare(r);
        if (nr) {
          accepted.add(nr);
          accepted.add(toHiragana(nr));
          accepted.add(toKatakana(nr));
        }
      });

      return accepted.has(raw) || accepted.has(userHira) || accepted.has(userKata);
    }

    // ===== 錯題庫區塊（顯示於「我的收藏」分頁下方，支援收合、單筆刪除與清空）=====
    let isWrongBankCollapsed = false;

    function clearWrongBank() {
      const now = Date.now();
      const nextItems = {};
      Object.entries(wrongBankStore.items || {}).forEach(([id, item]) => {
        if (item) nextItems[id] = { ...item, updatedAt: now, deleted: true };
      });
      wrongBankStore = {
        version: 1,
        updatedAt: now,
        items: nextItems
      };
      safeWriteJson(STORAGE_KEYS.wrongBank, wrongBankStore);
      scheduleCloudSyncPush();
    }

    function renderWrongBankSection() {
      const section = document.createElement('section');
      section.className = 'wrong-bank-section';

      const rawItems = Object.values(wrongBankStore.items || {})
        .filter(item => item && !item.deleted)
        .sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0));
      const resolved = rawItems
        .map(meta => ({ meta, entry: getEntryById(meta.id) }))
        .filter(item => !!item.entry);

      const header = document.createElement('div');
      header.className = 'wrong-bank-header';
      header.innerHTML = `
        <button class="wrong-bank-toggle" id="toggleWrongBankBtn" type="button" aria-expanded="${!isWrongBankCollapsed}">
          <span class="wrong-bank-chevron${isWrongBankCollapsed ? ' is-collapsed' : ''}" aria-hidden="true">▾</span>
          <span>錯題庫</span>
          ${resolved.length > 0 ? `<span class="wrong-bank-count">${resolved.length}</span>` : ''}
        </button>
        <div class="wrong-bank-header-actions">
          ${resolved.length > 0 ? `<button class="text-btn" id="collapseWrongBankTextBtn" type="button">${isWrongBankCollapsed ? '展開' : '收合'}</button>` : ''}
          ${resolved.length > 0 ? `<button class="text-btn" id="clearWrongBankBtn" type="button">清空錯題</button>` : ''}
        </div>
      `;
      section.appendChild(header);

      const toggleCollapse = () => {
        isWrongBankCollapsed = !isWrongBankCollapsed;
        renderCurrentView();
      };
      header.querySelector('#toggleWrongBankBtn').addEventListener('click', toggleCollapse);
      const colTextBtn = header.querySelector('#collapseWrongBankTextBtn');
      if (colTextBtn) colTextBtn.addEventListener('click', toggleCollapse);

      if (isWrongBankCollapsed) {
        return section;
      }

      if (resolved.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = `<strong>目前沒有錯題</strong><p>小考答錯或查看答案的單字會自動收錄在這裡，下次測驗答對後會自動移出。</p>`;
        section.appendChild(empty);
        return section;
      }

      header.querySelector('#clearWrongBankBtn').addEventListener('click', () => {
        clearWrongBank();
        renderCurrentView();
      });

      const list = document.createElement('div');
      list.className = 'word-list';

      resolved.forEach(({ entry }) => {
        const [kanjis, kanas, isCommon, senses, zhs] = entry;
        const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
        const primaryReading = toHiragana(kanas[0] || '');
        const showReading = kanjis.length > 0 && primaryReading && primaryReading !== primaryWord;
        const fav = isFavorite(entry);

        const cleanZhs = (zhs || []).filter(z => !/[㐀-䶿]/.test(z));
        let zhHtml = '';
        if (cleanZhs.length > 0) {
          zhHtml = `<div class="zh-meanings zh-compact">${cleanZhs.map(z => `<span class="zh-pill">${escapeHtml(z)}</span>`).join('')}</div>`;
        } else if (senses && senses[0] && senses[0].g && senses[0].g.length > 0) {
          zhHtml = `<div class="card-gloss-fallback">${escapeHtml(senses[0].g.slice(0, 3).join('; '))}</div>`;
        }

        const card = document.createElement('article');
        card.className = 'word-card clickable';
        card.innerHTML = `
          <div class="card-header${zhHtml ? ' has-below' : ''}">
            <div class="word-title-group">
              ${showReading ? `<div class="kana-reading">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="kanji-main">
                <span>${escapeHtml(primaryWord)}</span>
                ${isCommon ? '<span class="common-badge">常用</span>' : ''}
              </div>
            </div>
            <div class="card-actions">
              <button class="icon-btn speak-btn" type="button" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">${SPEAKER_SVG}</button>
              <button class="icon-btn copy-btn" type="button" title="複製單字" aria-label="複製單字" data-copy="${escapeHtml(primaryWord)}">${COPY_SVG}</button>
              <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" type="button" title="${fav ? '取消收藏' : '加入收藏'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
              </button>
              <button class="icon-btn del-wrong-btn" type="button" title="從錯題庫移除" aria-label="從錯題庫移除">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
          </div>
          ${zhHtml}
        `;

        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openDetail(entry, null);
        });
        card.querySelector('[data-speak]').addEventListener('click', (e) => {
          speakJapanese(e.currentTarget.getAttribute('data-speak'));
        });
        card.querySelector('[data-copy]').addEventListener('click', (e) => {
          e.stopPropagation();
          copyWordText(e.currentTarget.getAttribute('data-copy'), e.currentTarget);
        });
        card.querySelector('.fav-btn').addEventListener('click', () => {
          toggleFavorite(entry);
        });
        card.querySelector('.del-wrong-btn').addEventListener('click', () => {
          removeWordFromWrongBank(entry);
          renderCurrentView();
        });

        list.appendChild(card);
      });

      section.appendChild(list);
      return section;
    }

    // ===== 每日小考獨立畫面渲染（跳出不存進度，重開從第 1 題開始）=====
    let activeQuizState = null;

    function renderDailyQuizPage() {
      const wrap = document.createElement('section');
      wrap.className = 'quiz-view';

      if (!activeQuizState || activeQuizState.date !== localDateStr()) {
        activeQuizState = getOrCreateDailyQuiz(false);
      }
      const state = activeQuizState;

      if (state.completed) {
        return renderQuizSummaryPage(state);
      }

      const total = state.questions.length;
      if (total === 0) {
        wrap.innerHTML = `
          <div class="quiz-topbar">
            <h2 class="quiz-view-title">每日小考</h2>
          </div>
          <div class="empty-state">
            <strong>目前尚無可出題的單字</strong>
            <p>先搜尋或收藏幾個單字後，再來挑戰每日小考吧！</p>
          </div>
        `;
        return wrap;
      }

      const idx = Math.min(Math.max(0, state.currentIndex || 0), total - 1);
      state.currentIndex = idx;
      const qItem = state.questions[idx];
      const entry = getEntryById(qItem.id);
      if (!entry) {
        saveDailyQuizCompletion(state);
        return renderQuizSummaryPage(state);
      }

      const [kanjis, kanas, , senses] = entry;
      const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
      const primaryReading = toHiragana(kanas[0] || '');
      const showSeparateReading = kanjis.length > 0 && primaryReading && primaryReading !== primaryWord;
      const cleanZhs = getCleanZhList(entry);
      const zhPrimary = cleanZhs.length > 0
        ? cleanZhs[0]
        : (senses && senses[0] && senses[0].g ? senses[0].g[0] : '');
      const zhDisplay = cleanZhs.length > 0
        ? cleanZhs.slice(0, 4).join('；')
        : (senses && senses[0] && senses[0].g ? senses[0].g.slice(0, 2).join('; ') : '');

      const isJp2Zh = qItem.mode === 'jp2zh';
      const isAnswered = qItem.status !== 'pending';
      const isLast = idx === total - 1;
      const progressPct = Math.round(((idx + 1) / total) * 100);

      const promptHtml = isJp2Zh
        ? `
          <div class="quiz-card-top">
            <div class="quiz-prompt-col">
              <div class="quiz-mode-hint">
                <span class="quiz-mode-dir">日 → 中</span>
                <span>請輸入中文意思</span>
              </div>
              ${showSeparateReading ? `<div class="quiz-prompt-jp-kana">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="quiz-prompt-jp-main">${escapeHtml(primaryWord)}</div>
            </div>
            <button class="quiz-speak-box" type="button" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">${SPEAKER_SVG}</button>
          </div>
        `
        : `
          <div class="quiz-card-top">
            <div class="quiz-prompt-col">
              <div class="quiz-mode-hint">
                <span class="quiz-mode-dir">中 → 日</span>
                <span>請輸入日文單字或假名</span>
              </div>
              <div class="quiz-prompt-zh">${escapeHtml(zhDisplay)}</div>
            </div>
          </div>
        `;

      let bodyHtml = '';
      if (!isAnswered) {
        bodyHtml = `
          <div class="quiz-input-wrap">
            <input
              type="text"
              class="quiz-answer-input"
              id="quizAnswerInput"
              placeholder="${isJp2Zh ? '輸入中文意思，例如：貓' : '輸入日文單字或假名讀音'}"
              value=""
              autocomplete="off"
            />
            <button class="quiz-btn-primary" id="quizSubmitBtn" type="button">送出</button>
            <button class="quiz-skip-link" id="quizRevealBtn" type="button">不會，看答案</button>
          </div>
        `;
      } else {
        const fav = isFavorite(entry);
        let statusHtml = '';
        if (qItem.status === 'correct') {
          statusHtml = `
            <div class="quiz-result-status">
              <div class="quiz-status-line is-correct">✓ 答對了</div>
            </div>
          `;
        } else if (qItem.status === 'revealed') {
          statusHtml = `
            <div class="quiz-result-status">
              <div class="quiz-status-line is-wrong">已顯示答案</div>
              <div class="quiz-status-meta">已加入錯題庫</div>
            </div>
          `;
        } else {
          statusHtml = `
            <div class="quiz-result-status">
              <div class="quiz-status-line is-wrong">✗ 答錯了</div>
              <div class="quiz-status-meta">你的答案：${escapeHtml(qItem.userAnswer || '')}　·　已加入錯題庫</div>
            </div>
          `;
        }

        const answerMainHtml = isJp2Zh
          ? `
            <div class="quiz-answer-main-group">
              <div class="quiz-answer-text">${escapeHtml(zhPrimary)}</div>
              ${cleanZhs.length > 1 ? `<div class="quiz-answer-subzh">${escapeHtml(cleanZhs.slice(1, 4).join('；'))}</div>` : ''}
            </div>
          `
          : `
            <div class="quiz-answer-main-group">
              ${showSeparateReading ? `<div class="quiz-answer-reading">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="quiz-answer-text">${escapeHtml(primaryWord)}</div>
            </div>
          `;

        const answerSpeakHtml = !isJp2Zh
          ? `<button class="quiz-speak-box" type="button" title="日語發音" data-speak="${escapeHtml(primaryReading || primaryWord)}">${SPEAKER_SVG}</button>`
          : '';

        bodyHtml = `
          ${statusHtml}
          <hr class="quiz-divider" />
          <div class="quiz-answer-section">
            <div class="quiz-answer-label">正確答案</div>
            <div class="quiz-answer-row">
              ${answerMainHtml}
              <div class="quiz-answer-right">
                ${answerSpeakHtml}
                <button class="quiz-fav-text-btn ${fav ? 'is-fav' : ''}" id="quizRevealFavBtn" type="button">${fav ? '♥ 已收藏' : '♡ 收藏'}</button>
              </div>
            </div>
          </div>
          <button class="quiz-btn-primary" id="quizNextBtn" type="button">
            ${isLast ? '完成今日測驗' : '下一題 →'}
          </button>
        `;
      }

      wrap.innerHTML = `
        <div class="quiz-topbar">
          <h2 class="quiz-view-title">每日小考</h2>
          <span class="quiz-progress-text">${idx + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-track" aria-hidden="true">
          <div class="quiz-progress-fill" style="width: ${progressPct}%;"></div>
        </div>

        <article class="quiz-card">
          ${promptHtml}
          ${bodyHtml}
        </article>
        <div class="quiz-exit-wrap">
          <button class="quiz-exit-link" id="quizAbandonBtn" type="button">離開</button>
        </div>
      `;

      wrap.querySelectorAll('[data-speak]').forEach(btn => {
        btn.addEventListener('click', () => speakJapanese(btn.getAttribute('data-speak')));
      });

      if (!isAnswered) {
        const inputEl = wrap.querySelector('#quizAnswerInput');
        const handleEvaluate = (revealOnly) => {
          if (qItem.status !== 'pending') return;
          const val = inputEl ? inputEl.value.trim() : '';
          if (!revealOnly && !val) {
            if (inputEl) inputEl.focus();
            return;
          }

          qItem.userAnswer = val;
          if (revealOnly) {
            qItem.status = 'revealed';
            addWordToWrongBank(entry);
          } else {
            const ok = isJp2Zh
              ? checkJp2ZhAnswer(val, entry)
              : checkZh2JpAnswer(val, entry);
            if (ok) {
              qItem.status = 'correct';
              removeWordFromWrongBank(entry);
            } else {
              qItem.status = 'wrong';
              addWordToWrongBank(entry);
            }
          }
          renderCurrentView();
        };

        if (inputEl) {
          setTimeout(() => inputEl.focus(), 20);
          inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleEvaluate(false);
            }
          });
        }
        wrap.querySelector('#quizSubmitBtn').addEventListener('click', () => handleEvaluate(false));
        wrap.querySelector('#quizRevealBtn').addEventListener('click', () => handleEvaluate(true));
        const abandonBtnUnans = wrap.querySelector('#quizAbandonBtn');
        if (abandonBtnUnans) {
          abandonBtnUnans.addEventListener('click', () => {
            if (confirm('確定要放棄本次小考嗎？放棄後不會記錄今日完成，下次進入會重新出題。')) {
              activeQuizState = null;
              syncQuizLockClass();
              goHomeSearch();
            }
          });
        }
      } else {
        const favBtn = wrap.querySelector('#quizRevealFavBtn');
        if (favBtn) {
          favBtn.addEventListener('click', () => {
            toggleFavorite(entry, true);
            const nowFav = isFavorite(entry);
            favBtn.classList.toggle('is-fav', nowFav);
            favBtn.textContent = nowFav ? '♥ 已收藏' : '♡ 收藏';
          });
        }
        const abandonBtn = wrap.querySelector('#quizAbandonBtn');
        if (abandonBtn) {
          abandonBtn.addEventListener('click', () => {
            if (confirm('確定要放棄本次小考嗎？放棄後不會記錄今日完成，下次進入會重新出題。')) {
              activeQuizState = null;
              syncQuizLockClass();
              goHomeSearch();
            }
          });
        }
        const nextBtn = wrap.querySelector('#quizNextBtn');
        if (nextBtn) {
          setTimeout(() => nextBtn.focus(), 20);
          nextBtn.addEventListener('click', () => {
            if (isLast) {
              saveDailyQuizCompletion(state);
            } else {
              state.currentIndex = idx + 1;
            }
            renderCurrentView();
          });
        }
      }

      return wrap;
    }

    function renderQuizSummaryPage(state) {
      const wrap = document.createElement('section');
      wrap.className = 'quiz-view';

      const total = state.questions.length > 0 ? state.questions.length : (state.totalCount || 0);
      const correctCount = state.questions.length > 0
        ? state.questions.filter(q => q.status === 'correct').length
        : (state.correctCount || 0);

      wrap.innerHTML = `
        <div class="quiz-topbar">
          <h2 class="quiz-view-title">每日小考</h2>
          ${total > 0 ? `<span class="quiz-progress-text">${total} / ${total}</span>` : ''}
        </div>
        <div class="quiz-progress-track" aria-hidden="true">
          <div class="quiz-progress-fill" style="width: 100%;"></div>
        </div>

        <div class="quiz-summary-hero">
          <div class="quiz-summary-mascot-wrap">
            <img class="quiz-summary-mascot" src="./icons/celebrate-bird.png" alt="雪妖精小鳥" />
          </div>
          <div class="quiz-summary-title">恭喜完成</div>
          ${total > 0 ? `<div class="quiz-summary-score">今日答對 ${correctCount} / ${total} 題</div>` : ''}
        </div>

        <div class="quiz-summary-actions">
          <button class="quiz-btn-primary" id="quizBackHomeBtn" type="button">返回辭書首頁</button>
        </div>
      `;

      wrap.querySelector('#quizBackHomeBtn').addEventListener('click', () => {
        goHomeSearch();
      });

      return wrap;
    }

    const brandHomeBtn = document.getElementById('brandHomeBtn');
    if (brandHomeBtn) {
      brandHomeBtn.addEventListener('click', goHomeSearch);
      brandHomeBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goHomeSearch();
        }
      });
    }

    const accountBtn = document.getElementById('accountBtn');
    if (accountBtn) {
      accountBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!currentCloudUser) {
          triggerGoogleSignIn();
        } else if (isAccountPopoverOpen) {
          closeAccountPopover();
        } else {
          openAccountPopover(currentCloudUser);
        }
      });
    }
    document.addEventListener('click', () => {
      if (isAccountPopoverOpen) closeAccountPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isAccountPopoverOpen) closeAccountPopover();
    });

    updateCounts();
    updateQuizPendingDot();
    initOptionalFirebaseSync();
    loadDatabase();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
