export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const isAllowed =
      origin === "https://yahwd.github.io" ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:");

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : "https://yahwd.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const body = await request.json();
      const mode = String(body.mode || "segment").trim();
      const text = String(body.text || "").trim().slice(0, 220);

      if (!text) {
        return new Response(JSON.stringify({ translation: null, tokens: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (!env.GEMINI_API_KEY) {
        return new Response(
          JSON.stringify({
            error: "Missing GEMINI_API_KEY",
            detail: "請確認 Cloudflare Worker 的 Secrets 已設定 GEMINI_API_KEY 並重新部署。"
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }

      let prompt = "";
      if (mode === "translate") {
        const from = String(body.from || "auto").trim();
        const to = String(body.to || "zh-TW").trim();
        prompt = `你是精通日語與台灣繁體中文的翻譯助手。請將以下內容自然地翻譯成目標語言（來源語言代碼：${from}，目標語言代碼：${to}），僅回傳 JSON 物件（不要任何 Markdown 標記或額外說明）：
{
  "translated": "自然貼切的譯文（若目標為 zh-TW 請用台灣繁體中文；若目標為 ja 請給自然日文）",
  "reading": "若譯文為日文請提供完整平假名讀音，否則留空字串",
  "fromLabel": "來源語言繁體中文名稱（如：日文、中文、英文）",
  "toLabel": "目標語言繁體中文名稱（如：繁體中文、日文）"
}

原文：${text}`;
      } else {
        prompt = `你是日語文法與詞彙分析助手。請同時完成「整句自然翻譯」與「依語意和慣用語自然斷詞」，僅回傳 JSON 物件（不要任何 Markdown 標記或額外說明），格式如下：
{
  "translation": {
    "zh": "整句自然流暢的台灣繁體中文翻譯",
    "reading": "整句日文的平假名讀音"
  },
  "tokens": [
    {
      "surface": "原句中的片段",
      "base": "辭書原型",
      "reading": "平假名讀音",
      "pos": "繁體中文詞性（如名詞、動詞、形容詞、副詞、助詞、助動詞、慣用語）",
      "zh": "貼合此句上下文的簡潔台灣繁體中文釋義",
      "isParticle": false
    }
  ]
}

日文句子：${text}`;
      }

      const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
      let geminiRes = null;
      let lastErrText = "";
      let lastStatus = 502;

      for (const model of models) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
              }
            })
          }
        );

        if (res.ok) {
          geminiRes = res;
          break;
        }

        lastStatus = res.status;
        lastErrText = await res.text();
      }

      if (!geminiRes) {
        return new Response(
          JSON.stringify({
            error: `Gemini HTTP ${lastStatus}`,
            detail: lastErrText.slice(0, 500)
          }),
          {
            status: lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }

      const data = await geminiRes.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const cleanedText = rawText.replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(cleanedText);

      if (mode === "translate") {
        return new Response(JSON.stringify({
          translated: String(parsed?.translated || "").trim(),
          reading: String(parsed?.reading || "").trim(),
          fromLabel: String(parsed?.fromLabel || "").trim(),
          toLabel: String(parsed?.toLabel || "").trim()
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const tokens = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.tokens) ? parsed.tokens : []);
      const translation = parsed && !Array.isArray(parsed) && parsed.translation
        ? {
            zh: String(parsed.translation.zh || "").trim(),
            reading: String(parsed.translation.reading || "").trim()
          }
        : null;

      return new Response(JSON.stringify({ translation, tokens }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err?.message || "AI parse error",
          detail: String(err?.stack || "").slice(0, 500)
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
  }
};