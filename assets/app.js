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

    function executeSmartSearch(rawQuery) {
      const q = rawQuery.trim();
      if (!q || !isDbReady) return { mode: 'empty', results: [], note: '' };
      const qLower = q.toLowerCase();

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
        const exact = [];
        const partial = [];
        const escaped = qLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordRegex = new RegExp(`\\b${escaped}\\b`, 'i');

        for (let i = 0; i < dictData.length; i++) {
          const entry = dictData[i];
          const senses = entry[3];
          let isExact = false;
          let isPartial = false;
          for (let j = 0; j < senses.length; j++) {
            const glosses = senses[j].g;
            for (let k = 0; k < glosses.length; k++) {
              const gLow = glosses[k].toLowerCase();
              if (gLow === qLower || gLow === `to ${qLower}` || wordRegex.test(gLow)) {
                isExact = true;
                break;
              } else if (!isPartial && partial.length < 60 && gLow.includes(qLower)) {
                isPartial = true;
              }
            }
            if (isExact) break;
          }
          if (isExact) exact.push(entry);
          else if (isPartial) partial.push(entry);
          if (exact.length >= 80) break;
        }
        exact.sort((a, b) => b[2] - a[2]);
        partial.sort((a, b) => b[2] - a[2]);
        return {
          mode: 'en',
          badge: '英文 → 日文與發音',
          note: `搜尋英文釋義包含「${q}」的日文單字`,
          results: [...exact, ...partial].slice(0, 50)
        };
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
        `;

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
      currentSearchOutput = executeSmartSearch(query);
      resultCountEl.textContent = currentSearchOutput.results.length;

      if (saveHist && query.trim() && currentSearchOutput.results.length > 0) {
        addHistory(query.trim());
      }

      if (currentTab !== 'search') {
        switchTab('search');
      } else {
        renderCurrentView();
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
      });
      renderCurrentView();
    }

    function renderCurrentView() {
      strategyArea.innerHTML = '';
      mainContent.innerHTML = '';

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

        const modeClass = currentSearchOutput.mode === 'jp' ? 'mode-jp'
                        : currentSearchOutput.mode === 'en' ? 'mode-en' : 'mode-zh';
        strategyArea.innerHTML = `
          <div class="strategy-banner">
            <span>${escapeHtml(currentSearchOutput.note)}</span>
            <span class="mode-tag ${modeClass}">${escapeHtml(currentSearchOutput.badge || '')}</span>
          </div>
        `;
        const rendered = renderWordCards(currentSearchOutput.results);
        if (typeof rendered === 'string') mainContent.innerHTML = rendered;
        else mainContent.appendChild(rendered);
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
