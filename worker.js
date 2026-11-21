/**
 * 雪妖精の辭書 — Cloudflare Worker AI 代理服務
 * 環境變數設定：
 * - GEMINI_API_KEY（必填）
 * - GROQ_API_KEY（選填：Gemini 429 額度超限時自動免費備援）
 * - OPENROUTER_API_KEY（選填：第二層免費備援）
 */
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile'
];

const OPENROUTER_MODELS = [
  'openrouter/free'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

// 統一繁體中文、減少中英夾雜的核心規則
const ZH_TW_STRICT_RULES = `語言與風格嚴格規範：
1. 凡輸出繁體中文內容，必須全程使用自然、道地的「台灣繁體中文」，嚴禁使用簡體中文。
2. 除非是沒有常見中文譯名的專有名詞，否則「禁止中英夾雜」：外來語（カタカナ語）、片語或釋義請優先譯為自然中文或用中文語意完整表達，不要隨意插入英文單字、英文括號註解或中英混寫。
3. 輸出精簡乾淨，不要在翻譯或詞義欄位中夾帶多餘說明。`;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw e;
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 18000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiModels(apiKey, prompt, errors) {
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const maxAttempts = i === 0 ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: ZH_TW_STRICT_RULES }]
            },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.15,
              responseMimeType: 'application/json'
            }
          })
        }, 18000);

        if (!res.ok) {
          const errDetail = (await res.text().catch(() => '')).slice(0, 120);
          errors.push(`${model}(#${attempt}) HTTP ${res.status}${errDetail ? `: ${errDetail}` : ''}`);
          if (res.status === 404 || res.status === 400) {
            break;
          }
          if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
            await sleep(400);
            continue;
          }
          break;
        }

        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          errors.push(`${model}(#${attempt}) empty candidate`);
          break;
        }

        return { parsed: extractJsonObject(rawText), model };
      } catch (err) {
        errors.push(`${model}(#${attempt}): ${err.message || err}`);
        if (attempt < maxAttempts) {
          await sleep(400);
        }
      }
    }
  }
  return null;
}

async function callOpenAICompatible(providerName, baseUrl, apiKey, models, prompt, errors, extraHeaders = {}) {
  if (!apiKey) return null;
  for (const model of models) {
    try {
      const res = await fetchWithTimeout(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...extraHeaders
        },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `你是一個只會輸出合法 JSON 物件的日語辭典與翻譯引擎，禁止輸出任何 Markdown 或多餘文字。\n${ZH_TW_STRICT_RULES}`
            },
            { role: 'user', content: prompt }
          ]
        })
      }, 18000);

      if (!res.ok) {
        const errDetail = (await res.text().catch(() => '')).slice(0, 120);
        errors.push(`${providerName}:${model} HTTP ${res.status}${errDetail ? `: ${errDetail}` : ''}`);
        continue;
      }

      const data = await res.json();
      const rawText = data?.choices?.[0]?.message?.content;
      if (!rawText) {
        errors.push(`${providerName}:${model} empty content`);
        continue;
      }

      return { parsed: extractJsonObject(rawText), model: `${providerName}/${model}` };
    } catch (err) {
      errors.push(`${providerName}:${model}: ${err.message || err}`);
    }
  }
  return null;
}

async function callAiWithFallback(env, prompt) {
  const errors = [];

  if (env.GEMINI_API_KEY) {
    const geminiHit = await callGeminiModels(env.GEMINI_API_KEY, prompt, errors);
    if (geminiHit) return geminiHit;
  } else {
    errors.push('Missing GEMINI_API_KEY');
  }

  const groqHit = await callOpenAICompatible(
  'groq',
  'https://api.groq.com/openai/v1/chat/completions',
  env.GROQ_API_KEY,
  GROQ_MODELS,
  prompt,
  errors
);
if (groqHit) return groqHit;

const openRouterHit = await callOpenAICompatible(
  'openrouter',
  'https://openrouter.ai/api/v1/chat/completions',
  env.OPENROUTER_API_KEY,
  OPENROUTER_MODELS,
  prompt,
  errors,
  {
    'HTTP-Referer': 'https://yahwd.github.io/jp-dic/',
    'X-Title': 'Yukiyosei JP Dict'
  }
);
if (openRouterHit) return openRouterHit;

  throw new Error(errors.join(' | ') || 'All AI providers failed');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !env.OPENROUTER_API_KEY) {
      return jsonResponse({ ok: false, error: 'Missing AI API Keys' }, 500);
    }

    try {
      const body = await request.json();
      const mode = body.mode || 'translate';
      const text = String(body.text || '').trim();
      if (!text) {
        return jsonResponse({ ok: false, error: 'Empty text' }, 400);
      }

      if (mode === 'segment') {
        const prompt = `你是專業的日文教學與翻譯助手。請將以下日文句子進行「整句翻譯」、「逐詞語意拆解」，並在句子較長或含值得學習的句型與自他動詞時補充「文法解析」與「自他動詞對照」。請輸出嚴格符合 JSON 格式的物件，全面使用台灣繁體中文且避免中英夾雜：
{
  "translation": "自然流暢、純台灣繁體中文的整句翻譯（避免夾雜英文）",
  "context_note": "用一句簡短台灣繁體中文補充整句語氣或結構（例如：這是條件句的前半段，後面通常會接續說明結果；若為一般直述句可留空字串）",
  "reading": "整句的完整平假名讀音（保留適當標點與空白方便閱讀）",
  "tokens": [
    {
      "surface": "原句中的詞彙片段（勿遺漏助詞或活用形；嚴禁將句號「。」、逗號「、」、問號、驚嘆號等任何標點符號單獨列為 token）",
      "lemma": "辭書原型（若本身即原型則同 surface）",
      "reading": "該詞的平假名讀音",
      "pos": "台灣繁體中文詞性（如：名詞、五段動詞、一段動詞、い形容詞、な形容詞、副詞、助詞、助動詞、接續詞）",
      "meaning": "依本句上下文給出的簡潔純台灣繁體中文釋義（避免中英夾雜；若為助詞請簡述文法功能，如：主題助詞、對象助詞）",
      "isParticle": true或false
    }
  ],
  "grammar_notes": [
    {
      "pattern": "句型或文法結構名稱（例如：名詞＋を＋動詞、～ながら、～ていると）",
      "highlight": "原句中對應片段（例如：取りながら、とっていると）",
      "structure": "接續或文法結構簡述（例如：動詞ます形語幹＋ながら）",
      "explanation": "白話繁體中文說明（含語氣、用法或表記補充，例如：一邊……一邊……；在營養學文章中寫作「摂る」更明確）",
      "example": "簡短日文例句與中譯（例如：音楽を聞きながら勉強する。→ 一邊聽音樂一邊讀書。）"
    }
  ],
  "verb_pairs": [
    {
      "pairTitle": "成對動詞對照標題（例如：分ける vs 分かれる）",
      "items": [
        {
          "word": "單字與讀音（例如：分ける（わける））",
          "pos": "詞性（例如：他動詞）",
          "meaning": "意思（例如：分開、分類）",
          "example": "例句與中譯（例如：食品を二つに分ける。把食品分成兩類。）"
        }
      ]
    }
  ]
}

補充規則：
1. grammar_notes：僅在句子較長或出現值得注意的句型／文法結構時輸出 1～3 點；簡單短句或無特殊文法時請回傳空陣列 []。若詞彙有更精準的漢字表記（如「取る」在飲食營養語境可寫作「摂る」），請於 explanation 簡短補充。
2. verb_pairs：只要句中出現具備常見自他動詞配對的動詞（如 分ける／分かれる、始まる／始める、変わる／変える、開く／開ける、入る／入れる 等），請主動輸出 1～2 組自他動詞對照；若句中完全沒有這類動詞才回傳空陣列 []。

日文原句：${text}`;

        const { parsed, model } = await callAiWithFallback(env, prompt);
        const grammarNotes = Array.isArray(parsed.grammar_notes)
          ? parsed.grammar_notes
              .map(g => ({
                pattern: String((g && g.pattern) || '').trim(),
                highlight: String((g && g.highlight) || '').trim(),
                structure: String((g && g.structure) || '').trim(),
                explanation: String((g && g.explanation) || '').trim(),
                example: String((g && g.example) || '').trim()
              }))
              .filter(g => g.pattern && (g.explanation || g.structure))
          : [];

        const verbPairs = Array.isArray(parsed.verb_pairs)
          ? parsed.verb_pairs
              .map(vp => ({
                pairTitle: String((vp && vp.pairTitle) || '').trim(),
                items: Array.isArray(vp && vp.items)
                  ? vp.items
                      .map(it => ({
                        word: String((it && it.word) || '').trim(),
                        pos: String((it && it.pos) || '').trim(),
                        meaning: String((it && it.meaning) || '').trim(),
                        example: String((it && it.example) || '').trim()
                      }))
                      .filter(it => it.word && (it.meaning || it.pos))
                  : []
              }))
              .filter(vp => vp.pairTitle || vp.items.length > 0)
          : [];

        return jsonResponse({
          ok: true,
          mode: 'segment',
          model,
          translation: String(parsed.translation || '').trim(),
          context_note: String(parsed.context_note || '').trim(),
          reading: String(parsed.reading || '').trim(),
          tokens: Array.isArray(parsed.tokens)
            ? parsed.tokens
                .map(t => {
                  const cleanSurface = String((t && t.surface) || '')
                    .replace(/^[\s \p{P}\p{S}。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+|[\s \p{P}\p{S}。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+$/gu, '')
                    .trim();
                  const cleanLemma = String((t && t.lemma) || cleanSurface)
                    .replace(/^[\s \p{P}\p{S}。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+|[\s \p{P}\p{S}。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+$/gu, '')
                    .trim();
                  return { ...t, surface: cleanSurface, lemma: cleanLemma || cleanSurface };
                })
                .filter(t => t.surface && !/^[\s \p{P}\p{S}。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+$/u.test(t.surface))
            : [],
          grammar_notes: grammarNotes,
          verb_pairs: verbPairs
        });
      }

      const from = String(body.from || 'auto');
      const to = String(body.to || 'zh-TW');
      const wordContext = body.word ? `（日文原詞：${body.word}）` : '';

      const prompt = `你是專業的日漢翻譯引擎。請將以下內容翻譯為目標語言，並嚴格回傳 JSON 格式（若目標為 zh-TW，請全程使用純台灣繁體中文並避免中英夾雜）：
{
  "translation": "最自然精準的翻譯結果（若目標為 zh-TW 請使用純台灣繁體中文、避免夾雜英文；若為辭典單字釋義補全，請給出 1～3 個最貼切的台灣繁體中文詞義，以頓號「、」分隔，勿加多餘解釋）",
  "reading": "若目標語言為日文，請提供平假名讀音，否則留空字串",
  "detectedFrom": "偵測到的來源語言代碼（ja / zh-TW / en）"
}

來源語言：${from}
目標語言：${to}
待翻譯文字${wordContext}：${text}`;

      const { parsed, model } = await callAiWithFallback(env, prompt);
      return jsonResponse({
        ok: true,
        mode: 'translate',
        model,
        translation: String(parsed.translation || '').trim(),
        reading: String(parsed.reading || '').trim(),
        detectedFrom: String(parsed.detectedFrom || from)
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message || 'AI request failed' }, 502);
    }
  }
};