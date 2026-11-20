/**
 * 雪妖精の辭書 — Cloudflare Worker Gemini AI 代理服務
 * 環境變數需設定：GEMINI_API_KEY
 */
const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

async function callGeminiWithFallback(apiKey, prompt) {
  let lastError = 'All Gemini models failed';
  for (const model of MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!res.ok) {
        lastError = `${model} HTTP ${res.status}`;
        continue;
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        lastError = `${model} empty candidate`;
        continue;
      }

      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      return { parsed: JSON.parse(cleaned), model };
    } catch (err) {
      lastError = `${model}: ${err.message || err}`;
    }
  }
  throw new Error(lastError);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ ok: false, error: 'Missing GEMINI_API_KEY' }, 500);
    }

    try {
      const body = await request.json();
      const mode = body.mode || 'translate';
      const text = String(body.text || '').trim();
      if (!text) {
        return jsonResponse({ ok: false, error: 'Empty text' }, 400);
      }

      if (mode === 'segment') {
        const prompt = `你是專業的日文教學與翻譯助手。請將以下日文句子進行「整句翻譯」與「逐詞語意拆解」，輸出嚴格符合 JSON 格式的物件，全面使用台灣繁體中文：
{
  "translation": "自然流暢的台灣繁體中文整句翻譯",
  "reading": "整句的完整平假名讀音（保留適當標點與空白方便閱讀）",
  "tokens": [
    {
      "surface": "原句中的詞彙片段（勿遺漏助詞或活用形；嚴禁將句號「。」、逗號「、」、問號、驚嘆號等任何標點符號單獨列為 token）",
      "lemma": "辭書原型（若本身即原型則同 surface）",
      "reading": "該詞的平假名讀音",
      "pos": "台灣繁體中文詞性（如：名詞、五段動詞、一段動詞、い形容詞、な形容詞、副詞、助詞、助動詞、接續詞）",
      "meaning": "依本句上下文給出的簡潔台灣繁體中文釋義（若為助詞請簡述文法功能，如：主題助詞、對象助詞）",
      "isParticle": true或false
    }
  ]
}

日文原句：${text}`;

        const { parsed, model } = await callGeminiWithFallback(apiKey, prompt);
        return jsonResponse({
          ok: true,
          mode: 'segment',
          model,
          translation: String(parsed.translation || '').trim(),
          reading: String(parsed.reading || '').trim(),
          tokens: Array.isArray(parsed.tokens)
            ? parsed.tokens.filter(t => {
                const s = String((t && t.surface) || '').trim();
                return s && !/^[\s 。．.、，,!！?？・･·…‥「」『』（）()【】《》〈〉〜～—\-_:：;；/／\\|｜"'’“”]+$/.test(s);
              })
            : []
        });
      }

      const from = String(body.from || 'auto');
      const to = String(body.to || 'zh-TW');
      const wordContext = body.word ? `（日文原詞：${body.word}）` : '';

      const prompt = `你是專業的日漢英辭典翻譯引擎。請將以下內容翻譯為目標語言，並嚴格回傳 JSON 格式：
{
  "translation": "最自然精準的翻譯結果（若目標為 zh-TW 請使用台灣繁體中文；若為辭典單字釋義補全，請給出 1～3 個最貼切的台灣繁體中文詞義，以頓號「、」分隔，勿加多餘解釋）",
  "reading": "若目標語言為日文，請提供平假名讀音，否則留空字串",
  "detectedFrom": "偵測到的來源語言代碼（ja / zh-TW / en）"
}

來源語言：${from}
目標語言：${to}
待翻譯文字${wordContext}：${text}`;

      const { parsed, model } = await callGeminiWithFallback(apiKey, prompt);
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