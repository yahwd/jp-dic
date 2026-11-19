    let dictData = [];
    let zhBridge = {};
    let isDbReady = false;

    let currentTab = 'search';
    let favorites = JSON.parse(localStorage.getItem('private_jp_favs') || '[]');
    let historyList = JSON.parse(localStorage.getItem('private_jp_hist') || '[]');
    let currentSearchOutput = { mode: 'empty', results: [], note: '' };

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const mainContent = document.getElementById('mainContent');
    const strategyArea = document.getElementById('strategyArea');
    const resultCountEl = document.getElementById('resultCount');
    const favCountEl = document.getElementById('favCount');
    const histCountEl = document.getElementById('histCount');

    // 版本號需與 sw.js 的 CACHE_NAME 相同；更換 data 檔案後兩邊一起加 1
    const CACHE_NAME = 'yukiyosei-v1';

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
        setDbStatus('ready');
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
        document.getElementById('localLoaderBanner').style.display = 'flex';
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
        setDbStatus('ready');
        document.getElementById('localLoaderBanner').style.display = 'none';
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
        const lookup = executeSmartSearch(r.text);
        if (lookup.mode === 'jp') matches = lookup.results.slice(0, 5);
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
      s = s.replace(/-/g, '');
      if (!s) return null;
      let out = '';
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        const nx = s[i + 1];
        if (c === "'") { i++; continue; }
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
      const byCommonThenShort = (a, b) => (b[2] - a[2]) || ((a[1][0] || '').length - (b[1][0] || '').length);
      exact.sort(byCommonThenShort);
      prefix.sort(byCommonThenShort);
      partial.sort((a, b) => b[2] - a[2]);
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
        ...exact.slice(0, 50),
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

    function executeSmartSearch(rawQuery, opts) {
      opts = opts || {};
      const q = rawQuery.trim();
      if (!q || !isDbReady) return { mode: 'empty', results: [], note: '' };
      const qLower = q.toLowerCase();

      // 0. 純數字（半形／全形）-> 日文數字寫法與讀法
      if (isNumericQuery(q)) {
        const info = numberToJapanese(q);
        if (info) return searchNumber(q, info);
      }

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

      // 3. 漢字輸入 -> 優先檢查日文漢字；若日文無此漢字 -> 當作中文透過英文橋接反查日文
      if (hasHanzi(q)) {
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
          jpExact.sort((a, b) => b[2] - a[2]);
          jpPartial.sort((a, b) => b[2] - a[2]);
          return {
            mode: 'jp',
            badge: '漢字優先（命中日文漢字）',
            note: `日文辭典中直接收錄「${q}」`,
            results: [...jpExact, ...jpPartial].slice(0, 50)
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

        bridgedExact.sort((a, b) => b[2] - a[2]);
        bridgedPartial.sort((a, b) => b[2] - a[2]);
        tagMatches.sort((a, b) => b[2] - a[2]);

        return {
          mode: 'zh',
          badge: '中文轉譯 → 日文',
          note: keywords.length > 0
            ? `日文無此漢字，已透過英文橋接詞（${keywords.slice(0, 3).join(', ')}）找出對應日文`
            : `日文無此漢字，嘗試以中文語意反查「${q}」`,
          results: [...bridgedExact, ...bridgedPartial, ...tagMatches].slice(0, 50)
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
      const main = (entry[0] && entry[0][0]) || (entry[1] && entry[1][0]) || '';
      const reading = (entry[1] && entry[1][0]) || '';
      return `${main}__${reading}`;
    }

    function isFavorite(entry) {
      const id = getEntryId(entry);
      return favorites.some(f => getEntryId(f) === id);
    }

    function toggleFavorite(entry) {
      const id = getEntryId(entry);
      const idx = favorites.findIndex(f => getEntryId(f) === id);
      if (idx >= 0) {
        favorites.splice(idx, 1);
      } else {
        favorites.unshift(entry);
      }
      localStorage.setItem('private_jp_favs', JSON.stringify(favorites));
      updateCounts();
      renderCurrentView();
    }

    function addHistory(query) {
      const q = query.trim();
      if (!q) return;
      historyList = historyList.filter(item => item.q !== q);
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      historyList.unshift({ q, time: timeStr });
      if (historyList.length > 50) historyList.pop();
      localStorage.setItem('private_jp_hist', JSON.stringify(historyList));
      updateCounts();
    }

    function clearHistory() {
      historyList = [];
      localStorage.removeItem('private_jp_hist');
      updateCounts();
      renderCurrentView();
    }

    function updateCounts() {
      favCountEl.textContent = favorites.length;
      histCountEl.textContent = historyList.length;
      favCountEl.style.display = favorites.length ? '' : 'none';
      histCountEl.style.display = historyList.length ? '' : 'none';
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
        const primaryReading = kanas[0] || '';
        const altForms = [];
        if (kanjis.length > 1) altForms.push(...kanjis.slice(1));
        if (kanas.length > 1) altForms.push(...kanas.slice(1));

        const fav = isFavorite(entry);
        const card = document.createElement('article');
        card.className = 'word-card';

        let inflHtml = '';
        const inf = notes && notes.get(entry);
        if (inf) {
          const chain = inf.path.slice().reverse().join(' → ');
          inflHtml = `<div class="infl-note"><strong>${escapeHtml(inf.surface)}</strong> 是 <strong>${escapeHtml(inf.base)}</strong> 的變化形　${escapeHtml(chain)}${escapeHtml(inflectionExtra(inf))}</div>`;
        }

        let zhHtml = '';
        if (zhs && zhs.length > 0) {
          zhHtml = `<div class="zh-meanings">${zhs.map(z => `<span class="zh-pill">${escapeHtml(z)}</span>`).join('')}</div>`;
        }

        const sensesHtml = senses.slice(0, 5).map(s => {
          const pos = (s.p && s.p.length > 0) ? `<span class="pos-tag">${escapeHtml(s.p[0])}</span>` : '';
          const gloss = escapeHtml(s.g.join('; '));
          let exHtml = '';
          if (s.e && s.e.length > 0) {
            const [exJp, exEn] = s.e[0];
            exHtml = `
              <div class="example-box">
                <div class="ex-jp">
                  <span>${escapeHtml(exJp)}</span>
                  <button class="mini-speak" title="朗讀例句" data-speak="${escapeHtml(exJp)}">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                  </button>
                </div>
                <div class="ex-en">${escapeHtml(exEn)}</div>
              </div>
            `;
          }
          return `<div class="sense-item">${pos}<span class="en-gloss">${gloss}</span>${exHtml}</div>`;
        }).join('');

        card.innerHTML = `
          <div class="card-header">
            <div class="word-title-group">
              ${kanjis.length > 0 ? `<div class="kana-reading">${escapeHtml(primaryReading)}</div>` : ''}
              <div class="kanji-main">
                <span>${escapeHtml(primaryWord)}</span>
                ${isCommon ? '<span class="common-badge">常用</span>' : ''}
                ${altForms.length > 0 ? `<span class="alt-forms">(${escapeHtml(altForms.slice(0, 3).join('・'))})</span>` : ''}
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
              <button class="icon-btn fav-btn ${fav ? 'fav-active' : ''}" title="${fav ? '取消收藏' : '加入收藏'}">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
              </button>
            </div>
          </div>
          ${inflHtml}
          ${zhHtml}
          <div class="senses-list">${sensesHtml}</div>
          <div class="card-more">詳細頁・變化形 ›</div>
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

        container.appendChild(card);
      });

      return container;
    }

    function performSearch(query, saveHist = true) {
      clearBtn.style.display = query ? 'flex' : 'none';
      closeDetail();
      const token = ++searchToken;
      clearTimeout(translateTimer);
      currentSearchOutput = executeSmartSearch(query);
      resultCountEl.textContent = currentSearchOutput.results.length;
      resultCountEl.style.display = query.trim() ? '' : 'none';

      const q = query.trim();
      const needTranslate = isDbReady && q && currentSearchOutput.results.length === 0
        && currentSearchOutput.mode !== 'num';
      if (needTranslate) {
        currentSearchOutput.translate = { state: 'loading', query: q };
        startTranslate(q, token);
      }

      if (saveHist && q && (currentSearchOutput.results.length > 0 || currentSearchOutput.mode === 'num')) {
        addHistory(q);
      }

      if (currentTab !== 'search') {
        switchTab('search');
      } else {
        renderCurrentView();
      }
    }

    function switchTab(tab) {
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
    const DAILY_KEY = 'yukiyosei_daily_v1';
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
    function hashStr(str) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }
    function mulberry32(seed) {
      return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function seededShuffle(arr, rnd) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }

    // 以日期為種子：同一天固定同一組；localStorage 記錄已出現過的詞，輪完一輪才重新開始
    function getDailyPicks(dateStr) {
      const today = dateStr || localDateStr();
      const themes = resolveDailyThemes();
      const byId = new Map();
      themes.forEach(t => t.entries.forEach(e => byId.set(getEntryId(e), e)));

      let state = null;
      try { state = JSON.parse(localStorage.getItem(DAILY_KEY) || 'null'); } catch (e) { state = null; }

      if (state && state.date === today && Array.isArray(state.picks)) {
        const cached = state.picks.map(id => byId.get(id)).filter(Boolean);
        if (cached.length >= 5) return cached;
      }

      const rnd = mulberry32(hashStr(today));
      const seen = {
        core: new Set(state && state.seen && Array.isArray(state.seen.core) ? state.seen.core : []),
        supp: new Set(state && state.seen && Array.isArray(state.seen.supp) ? state.seen.supp : [])
      };
      const pickedIds = new Set();

      const take = (group, n) => {
        const groupThemes = themes.filter(t => t.group === group);
        const run = () => {
          const got = [];
          const avail = (t) => t.entries.filter(e => {
            const id = getEntryId(e);
            return !seen[group].has(id) && !pickedIds.has(id);
          });
          // 第一輪：每個主題最多取 1 個，讓當天的詞主題分散
          for (const t of seededShuffle(groupThemes, rnd)) {
            if (got.length >= n) break;
            const c = avail(t);
            if (c.length) {
              const e = c[Math.floor(rnd() * c.length)];
              got.push(e); pickedIds.add(getEntryId(e));
            }
          }
          // 第二輪：不夠再從所有未出現的詞補
          if (got.length < n) {
            const rest = seededShuffle(groupThemes.flatMap(avail), rnd);
            for (const e of rest) {
              if (got.length >= n) break;
              if (pickedIds.has(getEntryId(e))) continue;
              got.push(e); pickedIds.add(getEntryId(e));
            }
          }
          return got;
        };
        let got = run();
        if (got.length < n) {                  // 這個主題群組已輪完一輪 → 重新開始新的一輪
          seen[group].clear();
          got = got.concat((() => { const keep = got.length; const more = run(); return more.slice(0, n - keep); })());
        }
        got.forEach(e => seen[group].add(getEntryId(e)));
        return got;
      };

      const corePicks = take('core', DAILY_CORE_N);
      const suppPicks = take('supp', DAILY_TOTAL - DAILY_CORE_N);
      const picks = seededShuffle(corePicks.concat(suppPicks), rnd);

      try {
        localStorage.setItem(DAILY_KEY, JSON.stringify({
          date: today,
          picks: picks.map(getEntryId),
          seen: { core: [...seen.core], supp: [...seen.supp] }
        }));
      } catch (e) {}
      return picks;
    }

    function renderCurrentView() {
      strategyArea.innerHTML = '';
      mainContent.innerHTML = '';

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
          const title = document.createElement('h2');
          title.className = 'daily-title';
          title.textContent = '每日精選';
          mainContent.appendChild(title);
          const rendered = renderWordCards(getDailyPicks());
          if (typeof rendered === 'string') mainContent.innerHTML += rendered;
          else mainContent.appendChild(rendered);
          return;
        }

        const out = currentSearchOutput;

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

        const modeClass = out.mode === 'jp' || out.mode === 'num' ? 'mode-jp'
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
      } else if (currentTab === 'favorites') {
        if (favorites.length === 0) {
          mainContent.innerHTML = `<div class="empty-state"><strong>尚未收藏任何單字</strong><p>點擊單字卡片右上角的愛心圖示，即可將單字加入個人單字本。</p></div>`;
        } else {
          mainContent.appendChild(renderWordCards(favorites));
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

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });

    updateCounts();
    loadDatabase();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
