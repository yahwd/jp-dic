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

    async function loadDatabase() {
      const dot = document.getElementById('statusDot');
      const txt = document.getElementById('statusText');
      try {
        const [dictRes, bridgeRes] = await Promise.all([
          fetch('./data/dict_all.json'),
          fetch('./data/zh_bridge.json')
        ]);
        if (!dictRes.ok) throw new Error('dict_all.json fetch failed');
        dictData = await dictRes.json();
        if (bridgeRes.ok) {
          zhBridge = await bridgeRes.json();
        }
        isDbReady = true;
        dot.className = 'status-dot';
        txt.textContent = `完整詞庫已就緒 (${dictData.length.toLocaleString()} 詞)`;
        document.getElementById('localLoaderBanner').style.display = 'none';
        renderCurrentView();
      } catch (err) {
        dot.className = 'status-dot error';
        txt.textContent = '請選取 data 資料夾檔案';
        document.getElementById('localLoaderBanner').style.display = 'flex';
        mainContent.innerHTML = `
          <div class="empty-state">
            <strong>尚未載入詞庫檔案</strong>
            <p>若您直接雙擊開啟 HTML，請點擊下方按鈕同時選取 <code>data/dict_all.json</code> 與 <code>data/zh_bridge.json</code>；若部署至網頁空間則會自動載入。</p>
          </div>
        `;
      }
    }

    document.getElementById('jsonFileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      const dot = document.getElementById('statusDot');
      const txt = document.getElementById('statusText');
      dot.className = 'status-dot loading';
      txt.textContent = '正在讀取檔案...';

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
        dot.className = 'status-dot';
        txt.textContent = `完整詞庫已就緒 (${dictData.length.toLocaleString()} 詞)`;
        document.getElementById('localLoaderBanner').style.display = 'none';
        if (searchInput.value.trim()) performSearch(searchInput.value.trim(), false);
        else renderCurrentView();
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


    // 英文搜尋：釋義完全等於輸入字的詞優先（eat → 食べる），再依詞性順序、常用度排序
    function searchEnglish(q, qLower) {
      const escaped = qLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRegex = new RegExp(`\\b${escaped}\\b`);
      const toForm = `to ${qLower}`;
      const scored = [];

      for (let i = 0; i < dictData.length; i++) {
        const entry = dictData[i];
        const senses = entry[3];
        let best = 0;
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
            if (sc >= 60 && gClean !== gLow.trim()) sc -= 15; // 帶括號補充（如 go (board game)）略降
            sc -= Math.min(j, 6) * 4 + Math.min(k, 4);    // 越前面的釋義越重要
            sc -= Math.min(glosses.length - 1, 4);        // 該義項釋義越精簡越準
            if (sc > best) best = sc;
          }
        }
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
        results: scored.slice(0, 50).map(x => x[1])
      };
    }

    function executeSmartSearch(rawQuery) {
      const q = rawQuery.trim();
      if (!q || !isDbReady) return { mode: 'empty', results: [], note: '' };
      const qLower = q.toLowerCase();

      // 0. 純數字（半形／全形）-> 日文數字寫法與讀法
      if (isNumericQuery(q)) {
        const info = numberToJapanese(q);
        if (info) return searchNumber(q, info);
      }

      // 1. 日文假名或混合假名漢字 -> 直接比對日文
      if (hasKana(q)) {
        const exact = [];
        const prefix = [];
        const partial = [];
        for (let i = 0; i < dictData.length; i++) {
          const entry = dictData[i];
          const kanjis = entry[0];
          const kanas = entry[1];
          if (kanjis.includes(q) || kanas.includes(q)) {
            exact.push(entry);
          } else if (kanjis.some(k => k.startsWith(q)) || kanas.some(r => r.startsWith(q))) {
            prefix.push(entry);
          } else if (partial.length < 40 && (kanjis.some(k => k.includes(q)) || kanas.some(r => r.includes(q)))) {
            partial.push(entry);
          }
          if (exact.length >= 50) break;
        }
        exact.sort((a, b) => b[2] - a[2]);
        prefix.sort((a, b) => b[2] - a[2]);
        partial.sort((a, b) => b[2] - a[2]);
        return {
          mode: 'jp',
          badge: '日文假名檢索',
          note: `直接比對日文讀音與表記「${q}」`,
          results: [...exact, ...prefix, ...partial].slice(0, 50)
        };
      }

      // 2. 純英文 -> 搜尋英文釋義 -> 顯示對應日文與假名發音
      if (isAsciiEnglish(q)) {
        return searchEnglish(q, qLower);
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

    function detectConjType(entry) {
      const tags = new Set();
      entry[3].forEach(sn => (sn.p || []).forEach(t => tags.add(t)));
      const arr = [...tags];
      if (tags.has('vk')) return { kind: 'kuru', title: '来る（カ変動詞）' };
      if (tags.has('vs-i')) return { kind: 'suru', tag: 'vs-i', title: 'する（サ変動詞）' };
      if (tags.has('vs-s')) return { kind: 'suru', tag: 'vs-s', title: 'する動詞（特殊）' };
      const v5 = arr.find(t => /^v5/.test(t));
      if (v5) return { kind: 'godan', tag: v5, title: '五段動詞' };
      if (tags.has('v1') || tags.has('v1-s')) return { kind: 'ichidan', title: '一段動詞' };
      if (tags.has('adj-ix')) return { kind: 'adj-ix', title: 'い形容詞（いい型）' };
      if (tags.has('adj-i')) return { kind: 'adj-i', title: 'い形容詞' };
      if (tags.has('adj-na')) return { kind: 'adj-na', title: 'な形容詞' };
      if (tags.has('vs')) return { kind: 'suru-noun', title: '名詞＋する' };
      return null;
    }

    function godanRows(base, tag) {
      const last = base.slice(-1);
      const m = GODAN[last];
      if (!m) return null;
      const stem = base.slice(0, -1);
      let te = m.te, ta = m.ta, iStem = m.i, eImp = stem + m.e;
      if (tag === 'v5k-s') { te = 'って'; ta = 'った'; }
      if (tag === 'v5u-s') { te = 'うて'; ta = 'うた'; }
      if (tag === 'v5aru') { iStem = 'い'; eImp = stem + 'い'; }
      const isAru = tag === 'v5r-i';
      const neg = isAru ? 'ない' : stem + m.a + 'ない';
      const rows = [
        ['辞書形（原形）', base],
        ['ます形（禮貌）', stem + iStem + 'ます'],
        ['ました（禮貌過去）', stem + iStem + 'ました'],
        ['ません（禮貌否定）', stem + iStem + 'ません'],
        ['ない形（否定）', neg],
        ['なかった形（過去否定）', neg.slice(0, -1) + 'かった'],
        ['た形（過去）', stem + ta],
        ['て形', stem + te],
        ['ば形（假設）', stem + m.e + 'ば']
      ];
      if (!isAru) {
        rows.push(['可能形', stem + m.e + 'る']);
        rows.push(['受身形（被動）', stem + m.a + 'れる']);
      }
      if (!isAru) rows.push(['使役形', stem + m.a + 'せる']);
      rows.push(['意志形（…吧）', stem + m.o + 'う']);
      rows.push(['命令形', eImp]);
      rows.push(['禁止形（不要…）', base + 'な']);
      return rows;
    }

    function ichidanRows(base) {
      if (!base.endsWith('る')) return null;
      const st = base.slice(0, -1);
      return [
        ['辞書形（原形）', base],
        ['ます形（禮貌）', st + 'ます'],
        ['ました（禮貌過去）', st + 'ました'],
        ['ません（禮貌否定）', st + 'ません'],
        ['ない形（否定）', st + 'ない'],
        ['なかった形（過去否定）', st + 'なかった'],
        ['た形（過去）', st + 'た'],
        ['て形', st + 'て'],
        ['ば形（假設）', st + 'れば'],
        ['可能形', st + 'られる'],
        ['受身形（被動）', st + 'られる'],
        ['使役形', st + 'させる'],
        ['意志形（…吧）', st + 'よう'],
        ['命令形', st + 'ろ'],
        ['禁止形（不要…）', base + 'な']
      ];
    }

    function suruRows(pref, tag) {
      const sp = tag === 'vs-s';
      return [
        ['辞書形（原形）', pref + 'する'],
        ['ます形（禮貌）', pref + 'します'],
        ['ました（禮貌過去）', pref + 'しました'],
        ['ません（禮貌否定）', pref + 'しません'],
        ['ない形（否定）', pref + (sp ? 'さない' : 'しない')],
        ['なかった形（過去否定）', pref + (sp ? 'さなかった' : 'しなかった')],
        ['た形（過去）', pref + 'した'],
        ['て形', pref + 'して'],
        ['ば形（假設）', pref + 'すれば'],
        ['可能形', pref + (sp ? 'せる' : 'できる')],
        ['受身形（被動）', pref + 'される'],
        ['使役形', pref + 'させる'],
        ['意志形（…吧）', pref + 'しよう'],
        ['命令形', pref + 'しろ'],
        ['禁止形（不要…）', pref + 'するな']
      ];
    }

    function kuruRows(pref, c) {
      return [
        ['辞書形（原形）', pref + c.ku + 'る'],
        ['ます形（禮貌）', pref + c.ki + 'ます'],
        ['ました（禮貌過去）', pref + c.ki + 'ました'],
        ['ません（禮貌否定）', pref + c.ki + 'ません'],
        ['ない形（否定）', pref + c.ko + 'ない'],
        ['なかった形（過去否定）', pref + c.ko + 'なかった'],
        ['た形（過去）', pref + c.ki + 'た'],
        ['て形', pref + c.ki + 'て'],
        ['ば形（假設）', pref + c.ku + 'れば'],
        ['可能形', pref + c.ko + 'られる'],
        ['受身形（被動）', pref + c.ko + 'られる'],
        ['使役形', pref + c.ko + 'させる'],
        ['意志形（…吧）', pref + c.ko + 'よう'],
        ['命令形', pref + c.ko + 'い'],
        ['禁止形（不要…）', pref + c.ku + 'るな']
      ];
    }

    function adjIRows(base, irregular) {
      if (!base.endsWith('い')) return null;
      const st = irregular && base.endsWith('いい') ? base.slice(0, -2) + 'よ' : base.slice(0, -1);
      return [
        ['辞書形（原形）', base],
        ['禮貌', base + 'です'],
        ['否定', st + 'くない'],
        ['過去', st + 'かった'],
        ['過去否定', st + 'くなかった'],
        ['て形', st + 'くて'],
        ['副詞形', st + 'く'],
        ['名詞化', st + 'さ'],
        ['ば形（假設）', st + 'ければ']
      ];
    }

    function adjNaRows(base) {
      return [
        ['辞書形（原形）', base],
        ['修飾名詞', base + 'な'],
        ['否定', base + 'じゃない'],
        ['過去', base + 'だった'],
        ['過去否定', base + 'じゃなかった'],
        ['て形', base + 'で'],
        ['副詞形', base + 'に'],
        ['禮貌', base + 'です'],
        ['禮貌否定', base + 'ではありません'],
        ['條件', base + 'なら']
      ];
    }

    function rowsFor(type, base, isWritten) {
      if (!base) return null;
      switch (type.kind) {
        case 'godan': return godanRows(base, type.tag);
        case 'ichidan': return ichidanRows(base);
        case 'adj-i': return adjIRows(base, false);
        case 'adj-ix': return adjIRows(base, true);
        case 'adj-na': return adjNaRows(base);
        case 'suru-noun': return suruRows(base, 'vs');
        case 'suru': {
          if (!base.endsWith('する')) return null;
          return suruRows(base.slice(0, -2), type.tag);
        }
        case 'kuru': {
          if (base.endsWith('来る') || base.endsWith('來る')) {
            const k = base.charAt(base.length - 2);
            return kuruRows(base.slice(0, -2), { ko: k, ki: k, ku: k });
          }
          if (base.endsWith('くる')) {
            return kuruRows(base.slice(0, -2), { ko: 'こ', ki: 'き', ku: 'く' });
          }
          return null;
        }
      }
      return null;
    }

    function buildConjugation(entry) {
      const type = detectConjType(entry);
      if (!type) return null;
      const written = entry[0] && entry[0][0] ? entry[0][0] : null;
      const reading = entry[1] && entry[1][0] ? entry[1][0] : null;
      const wRows = written ? rowsFor(type, written, true) : null;
      const rRows = reading ? rowsFor(type, reading, false) : null;
      const base = wRows || rRows;
      if (!base) return null;
      const rows = base.map((r, i) => ({
        label: r[0],
        written: wRows ? wRows[i][1] : null,
        reading: rRows ? rRows[i][1] : null
      }));
      return { title: type.title, rows };
    }

    // ===== 詳細頁 =====
    let currentDetail = null;
    let savedScrollY = 0;

    function openDetail(entry) {
      savedScrollY = window.scrollY;
      currentDetail = entry;
      try { history.pushState({ detail: true }, ''); } catch (e) {}
      renderCurrentView();
      window.scrollTo(0, 0);
    }

    function closeDetail() {
      if (!currentDetail) return false;
      currentDetail = null;
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

    function renderDetailPage(entry) {
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
      let conjHtml = '';
      if (conj) {
        conjHtml = `
          <section class="detail-section">
            <h3 class="detail-h">變化形 <span class="detail-h-sub">${escapeHtml(conj.title)}</span></h3>
            <div class="conj-table">
              ${conj.rows.map(r => {
                const main = r.written || r.reading;
                const sub = (r.written && r.reading && r.reading !== r.written) ? `<div class="conj-reading">${escapeHtml(r.reading)}</div>` : '';
                const sp = r.reading || r.written;
                return `<div class="conj-row">
                  <div class="conj-label">${escapeHtml(r.label)}</div>
                  <div class="conj-form"><div class="conj-main">${escapeHtml(main)}</div>${sub}</div>
                  <button class="mini-speak" title="朗讀" data-speak="${escapeHtml(sp)}">${SPEAKER_SVG.replace(/width="17" height="17"/, 'width="15" height="15"')}</button>
                </div>`;
              }).join('')}
            </div>
            <p class="conj-note">變化形由規則自動產生，罕見詞或特殊用法請以辭典為準。</p>
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
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderWordCards(entries) {
      if (!entries || entries.length === 0) {
        return `<div class="empty-state">
          <strong>找不到相符的單字</strong>
          <p>請嘗試其他假名、漢字或英文關鍵字。</p>
        </div>`;
      }

      const container = document.createElement('div');
      container.className = 'word-list';

      entries.forEach((entry) => {
        const [kanjis, kanas, isCommon, senses, zhs] = entry;
        const primaryWord = kanjis.length > 0 ? kanjis[0] : kanas[0];
        const primaryReading = kanas[0] || '';
        const altForms = [];
        if (kanjis.length > 1) altForms.push(...kanjis.slice(1));
        if (kanas.length > 1) altForms.push(...kanas.slice(1));

        const fav = isFavorite(entry);
        const card = document.createElement('article');
        card.className = 'word-card';

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
          ${zhHtml}
          <div class="senses-list">${sensesHtml}</div>
          <div class="card-more">詳細頁・變化形 ›</div>
        `;
        card.classList.add('clickable');
        card.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openDetail(entry);
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

    function renderCurrentView() {
      strategyArea.innerHTML = '';
      mainContent.innerHTML = '';

      if (currentDetail) {
        mainContent.appendChild(renderDetailPage(currentDetail));
        return;
      }

      if (currentTab === 'search') {
        if (!isDbReady) return;

        if (!searchInput.value.trim()) {
          const commonSample = dictData.filter(x => x[2] === 1).slice(0, 8);
          resultCountEl.textContent = commonSample.length;
          strategyArea.innerHTML = `
            <div class="strategy-banner">
              <span>已載入全部 ${dictData.length.toLocaleString()} 筆詞條，輸入日文、漢字或英文即可即時檢索</span>
              <span class="mode-tag mode-jp">三向智慧引擎就緒</span>
            </div>
          `;
          mainContent.appendChild(renderWordCards(commonSample));
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
        if (out.mode === 'num' && out.numberInfo) {
          mainContent.appendChild(renderNumberCard(out.numberInfo));
        }
        if (out.results.length > 0 || out.mode !== 'num') {
          const rendered = renderWordCards(out.results);
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
