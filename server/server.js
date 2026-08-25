const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ENV = {};
try {
  const t = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  t.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  });
} catch (e) {}

function env(k, d) {
  const v = ENV[k] !== undefined ? ENV[k] : process.env[k];
  return v !== undefined && v !== "" ? v : d;
}

const PORT = parseInt(env("PORT", "3001"), 10);
const DEEPSEEK_KEY = env("DEEPSEEK_API_KEY", "");
const DOUBAO_KEY = env("DOUBAO_API_KEY", "");
const DOUBAO_MODEL = env("DOUBAO_MODEL", "doubao-1-5-pro-32k-250115");
const DOUBAO_FAST_MODEL = env("DOUBAO_FAST_MODEL", "deepseek-v4-flash-260425");
const DOUBAO_VISION_MODEL = env("DOUBAO_VISION_MODEL", "doubao-1-5-vision-pro-32k-250115");
const DASHSCOPE_KEY = env("DASHSCOPE_API_KEY", "");
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/api/v1/services/aigc";
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

const SYSTEM_PROMPT =
  "你是「健康小管家」，一位说话亲切、耐心的健康助手，专门服务刚退休、文化程度不高的中国中老年人。\n" +
  "必须遵守：\n" +
  "1. 说话口语化、简短，一般不超过100字，一次只说一件事，多用比喻，少用医学术语（例：血压像水管里的水压）。\n" +
  "2. 称呼用户为「叔叔」或「阿姨」。\n" +
  "3. 永远先安抚情绪，再讲内容，语气平稳，不吓人也不敷衍。\n" +
  "4. 你不是医生：不能诊断疾病，不能开药、不能给出任何药品剂量，涉及诊疗建议时必须带一句「仅供参考，不能代替医生」。\n" +
  "5. 用户描述严重危险症状（胸痛、胸闷、呼吸困难、喘不上气、昏迷、晕倒、大出血、抽搐、面部歪斜、一侧手脚无力、说话不清等）时，必须明确建议立即拨打120或立即就医，语气坚定，不模棱两可。\n" +
  "6. 给出的建议要有明确的下一步行动（观察什么、挂哪个科室、是否就医）。\n" +
  "7. 禁止任何医疗以外的推广、广告、营销内容。\n" +
  "8. 每次回答都以固定格式结尾，给出 3 个用户接下来想点选的短句（给老人点选，每个不超过12个字）。这 3 个短句必须用用户自己的口气（用「我」开头），分别对应三种作用：\n" +
  "① 回应你刚才说的话（陈述，如：好，我知道了；情况是这样的）\n" +
  "② 针对你刚才的回答提出的新疑问（如：那我该怎么解决这个事）\n" +
  "③ 向你说说自己平时的状态（如：我平时晚上睡不太好）\n" +
  "格式必须是：【建议】1.短句一；2.短句二；3.短句三\n" +
  "例如你回答完血压怎么调养后，结尾写：【建议】1.好，我知道了；2.那我该怎么坚持；3.我平时容易头晕";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const PROTOTYPE_DIR = path.join(__dirname, "..", "prototype");
const DATA_DIR = path.join(__dirname, "data");
const historyFile = path.join(DATA_DIR, "history.json");
const memoryFile = path.join(DATA_DIR, "memory.json");

function readJSON(file, dflt) {
  return new Promise((res) => {
    fs.readFile(file, "utf8", (err, data) => {
      if (err) return res(dflt);
      try { res(JSON.parse(data)); } catch (e) { res(dflt); }
    });
  });
}

function writeJSON(file, val) {
  return new Promise((res) => {
    fs.mkdir(path.dirname(file), { recursive: true }, () => {
      fs.writeFile(file, JSON.stringify(val, null, 2), "utf8", () => res());
    });
  });
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(PROTOTYPE_DIR, rel);
  if (filePath !== PROTOTYPE_DIR && !filePath.startsWith(PROTOTYPE_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found: " + rel);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((res, rej) => {
    let d = "";
    let tooBig = false;
    req.on("data", (c) => {
      d += c;
      if (d.length > 20 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => (tooBig ? rej(new Error("请求体过大(>20MB)")) : res(d)));
    req.on("error", rej);
  });
}

function profileContext(p) {
  if (!p) return "";
  var lines = [];
  if (p.callName) lines.push("称呼用户为：" + p.callName);
  if (p.name) lines.push("姓名：" + p.name);
  if (p.birth && /^\d{4}$/.test(String(p.birth))) lines.push("年龄：约" + (new Date().getFullYear() - parseInt(p.birth, 10)) + "岁");
  if (p.disease) lines.push("既往病史：" + p.disease);
  if (p.allergy) lines.push("过敏史：" + p.allergy);
  if (p.medicine) lines.push("常用药：" + p.medicine);
  if (p.bp) lines.push("最近血压：" + p.bp);
  if (p.bloodSugar) lines.push("最近血糖：" + p.bloodSugar);
  if (p.height && p.weight) {
    var bmi = (parseFloat(p.weight) / ((parseFloat(p.height) / 100) * (parseFloat(p.height) / 100))).toFixed(1);
    lines.push("身高体重：" + p.height + "cm/" + p.weight + "kg（BMI " + bmi + "）");
  }
  if (p.lifestyle) lines.push("生活习惯：" + p.lifestyle);
  if (p.hospital) lines.push("常去医院：" + p.hospital);
  if (!lines.length) return "";
  return "【用户健康档案】\n" + lines.join("；") + "\n（回答时要结合档案，但不要照着念给用户听）";
}

function buildMessages(messages, imageDataURL, profileStr, systemOverride) {
  const sys = systemOverride || (SYSTEM_PROMPT + (profileStr ? "\n\n" + profileStr : ""));
  const msgs = [{ role: "system", content: sys }].concat(messages);
  if (imageDataURL && msgs.length) {
    const last = msgs[msgs.length - 1];
    last.content = [
      { type: "text", text: typeof last.content === "string" ? last.content : "请帮我看看这张照片。" },
      { type: "image_url", image_url: { url: imageDataURL } },
    ];
  }
  return msgs;
}

async function arkChat(messages, imageDataURL, model, profileStr, systemOverride) {
  if (!DOUBAO_KEY) throw new Error("未配置 DOUBAO_API_KEY");
  const msgs = buildMessages(messages, imageDataURL, profileStr, systemOverride);
  const m = model || (imageDataURL ? DOUBAO_VISION_MODEL : DOUBAO_MODEL);
  const resp = await fetch(ARK_BASE + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + DOUBAO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: m, messages: msgs, temperature: 0.6, max_tokens: 600, thinking: { type: "disabled" } }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = (j.error && (j.error.message || j.error.code)) || "HTTP " + resp.status;
    throw new Error("豆包接口错误：" + e);
  }
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

async function deepseekChat(messages, imageDataURL, profileStr) {
  if (imageDataURL) throw new Error("DeepSeek 当前不支持图片");
  if (!DEEPSEEK_KEY) throw new Error("未配置 DEEPSEEK_API_KEY");
  const msgs = [{ role: "system", content: SYSTEM_PROMPT + (profileStr ? "\n\n" + profileStr : "") }].concat(messages);
  const resp = await fetch(DEEPSEEK_BASE + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + DEEPSEEK_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", messages: msgs, temperature: 0.6, max_tokens: 600 }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = (j.error && (j.error.message || j.error.type)) || "HTTP " + resp.status;
    throw new Error("DeepSeek 接口错误：" + e);
  }
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

async function qwenTTS(text, voice) {
  if (!DASHSCOPE_KEY) throw new Error("未配置 DASHSCOPE_API_KEY");
  const resp = await fetch(DASHSCOPE_BASE + "/multimodal-generation/generation", {
    method: "POST",
    headers: { Authorization: "Bearer " + DASHSCOPE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-tts",
      input: { text: text.slice(0, 300) },
      parameters: { voice: voice, format: "mp3" },
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = (j.message || j.code) || "HTTP " + resp.status;
    throw new Error("千问TTS错误：" + e);
  }
  const url = j.output && j.output.audio && j.output.audio.url;
  if (!url) throw new Error("千问TTS未返回音频");
  const aresp = await fetch(url);
  if (!aresp.ok) throw new Error("千问TTS音频下载失败 " + aresp.status);
  return Buffer.from(await aresp.arrayBuffer());
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cleanSpeechText(raw) {
  return String(raw)
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function edgeTTS(text, voice) {
  return new Promise((resolve) => {
    if (typeof WebSocket === "undefined") { resolve(Buffer.alloc(0)); return; }
    const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    const connId = crypto.randomUUID();
    const reqId = crypto.randomUUID();
    const url =
      "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" +
      token +
      "&ConnectionId=" +
      connId;
    let ws = null;
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      try { if (ws) ws.close(); } catch (e) {}
      resolve(buf);
    };
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve(Buffer.alloc(0));
      return;
    }
    ws.binaryType = "arraybuffer";
    const chunks = [];
    const ts = () => new Date().toISOString();
    ws.onopen = () => {
      try {
        ws.send(
          "X-Timestamp:" + ts() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" },
                },
              },
            })
        );
        const ssml =
          '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="' +
          voice +
          '"><prosody pitch="+0%" rate="+0%" volume="+0%">' +
          escapeXml(text) +
          "</prosody></voice></speak>";
        ws.send("X-RequestId:" + reqId + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + ts() + "\r\nPath:ssml\r\n\r\n" + ssml);
      } catch (e) {
        finish(Buffer.alloc(0));
      }
    };
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") {
          if (ev.data.indexOf("Path:turn.end") > -1) finish(Buffer.concat(chunks));
          return;
        }
        const buf = Buffer.from(ev.data);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        const header = buf.subarray(2, 2 + headerLen).toString("utf8");
        if (header.indexOf("Path:audio") > -1) {
          const b64 = buf.subarray(2 + headerLen).toString("utf8").trim();
          const audio = Buffer.from(b64, "base64");
          if (audio.length) chunks.push(audio);
        }
      } catch (e) {}
    };
    ws.onerror = () => finish(Buffer.alloc(0));
    ws.onclose = () => finish(Buffer.concat(chunks));
    setTimeout(() => finish(Buffer.concat(chunks)), 12000);
  });
}

const VOICE_MAP = {
  peach: { type: "qwen", voice: "longxiaochun" },
  cancan: { type: "qwen", voice: "longwan" },
  qingxin: { type: "qwen", voice: "longwanxiaoyue" },
  edge: { type: "edge", voice: "zh-CN-XiaoyiNeural" },
  "edge-yunxi": { type: "edge", voice: "zh-CN-YunxiNeural" },
};

async function handleTTS(u, res) {
  const raw = (u.searchParams.get("text") || "").slice(0, 500);
  const text = raw.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu, "").replace(/\s+/g, " ").trim();
  const vk = u.searchParams.get("voice") || "peach";
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "缺少 text 参数" }));
    return;
  }
  const v = VOICE_MAP[vk] || VOICE_MAP.peach;
  let buf = null;
  if (v.type === "qwen") {
    try {
      buf = await qwenTTS(text, v.voice);
    } catch (e) {
      buf = await edgeTTS(text, "zh-CN-XiaoyiNeural");
    }
  } else {
    buf = await edgeTTS(text, v.voice);
  }
  if (!buf || !buf.length) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "语音合成失败" }));
    return;
  }
  const magic = buf.subarray(0, 4).toString("latin1");
  const ctype = magic === "RIFF" ? "audio/wav" : "audio/mpeg";
  res.writeHead(200, { "Content-Type": ctype });
  res.end(buf);
}

function parseSuggestions(reply) {
  const marker = String(reply).lastIndexOf("【建议】");
  if (marker < 0) return { reply, suggestions: [] };
  const clean = String(reply).slice(0, marker).trim();
  const body = String(reply).slice(marker + "【建议】".length);
  const items = body
    .split(/[0-9]+[.、．]/)
    .map((s) => s.trim().replace(/[；;。.]$/g, ""))
    .filter(Boolean)
    .slice(0, 3);
  return { reply: clean || reply, suggestions: items };
}

async function askSuggestions(messages, image, profileStr) {
  const prompt =
    "根据上面这段对话，只输出 3 个短句（每句不超过12个字，中文，用分号分隔），这 3 句是用户接下来想点选的，必须用「我」的口气，分别对应三种作用：①回应AI刚才说的话（陈述）；②针对AI刚才回答提出的新疑问；③向AI说说自己平时的状态。不要编号、不要解释、不要其他任何内容。";
  const msg = messages.concat([{ role: "user", content: prompt }]);
  const raw = await arkChat(msg, image, image ? DOUBAO_VISION_MODEL : DOUBAO_FAST_MODEL, profileStr);
  return String(raw)
    .split(/[；;，,。.!！\n]+/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 15)
    .slice(0, 3);
}

async function generateMemory(existing, conversation) {
  const sys =
    "你是「健康小管家」的记忆管家。下面会给你的内容是：【旧记忆】和一段【新对话】。\n" +
    "请把用户的重要信息整理成一份简短记忆，包括：健康状况、症状、用药、生活习惯、家庭情况、常聊的话题、用户说过的关键话。\n" +
    "要求：不超过8条、每条一行、简短清楚；新的重要信息要加入，过时的要删除；不要寒暄和解释，直接输出记忆内容。";
  const text =
    "【旧记忆】\n" + (existing || "无") +
    "\n\n【新对话】\n" +
    conversation.map((m) => (m.role === "user" ? "用户：" : "小管家：") + (m.content || "")).join("\n").slice(-4000);
  const reply = await arkChat([{ role: "user", content: text }], null, DOUBAO_FAST_MODEL, null, sys);
  return reply.trim().slice(0, 800);
}

async function handleChat(u, req, res) {
  const body = JSON.parse((await readBody(req)) || "{}");
  const provider = body.provider === "deepseek" ? "deepseek" : "doubao";
  const msgs = (body.messages || []).slice(-14);
  const image = typeof body.image === "string" ? body.image : null;
  let ctx = profileContext(body.profile && typeof body.profile === "object" ? body.profile : null);
  const memory = await readJSON(memoryFile, "");
  if (memory) ctx += (ctx ? "\n\n" : "") + "【长期记忆】\n" + memory;
  if (body.profile && body.profile.callName) {
    ctx += "\n\n（重要：称呼用户必须用「" + body.profile.callName + "」这个称呼，不要叫成别的）";
  }
  let reply = "";
  if (provider === "deepseek") {
    reply = await deepseekChat(msgs, image, ctx);
  } else {
    reply = await arkChat(msgs, image, null, ctx);
  }
  const parsed = parseSuggestions(reply);
  if (!parsed.reply.trim()) parsed.reply = "不好意思，" + (body.profile && body.profile.callName ? body.profile.callName : "您") + "，我这会儿没听清，您再说一遍好吗？";
  let suggestions = parsed.suggestions;
  if (!suggestions.length) {
    try {
      const extra = await askSuggestions(msgs, image, ctx);
      if (extra.length) suggestions = extra;
    } catch (e) {}
  }
  let audioBase64 = "";
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ reply: parsed.reply, suggestions, full: reply, audioBase64 }));
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const u = new URL(req.url, "http://localhost");
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + u.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (u.pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, doubao: !!DOUBAO_KEY, deepseek: !!DEEPSEEK_KEY, dashscope: !!DASHSCOPE_KEY }));
    } else if (u.pathname === "/api/chat" && req.method === "POST") {
      await handleChat(u, req, res);
    } else if (u.pathname === "/api/history" && req.method === "GET") {
      const j = await readJSON(historyFile, {});
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ messages: Array.isArray(j.messages) ? j.messages : [] }));
    } else if (u.pathname === "/api/history" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const messages = Array.isArray(body.messages) ? body.messages.slice(-200) : [];
      await writeJSON(historyFile, { messages });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, count: messages.length }));
    } else if (u.pathname === "/api/memory" && req.method === "GET") {
      const memory = await readJSON(memoryFile, "");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ memory }));
    } else if (u.pathname === "/api/memory" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const conversation = Array.isArray(body.conversation) ? body.conversation : [];
      const existing = await readJSON(memoryFile, "");
      const memory = await generateMemory(existing, conversation);
      await writeJSON(memoryFile, memory);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ memory }));
    } else if (u.pathname === "/api/tts" && req.method === "GET") {
      await handleTTS(u, res);
    } else if (req.method === "GET" && u.pathname.indexOf("/api/") !== 0) {
      serveStatic(req, res, u.pathname);
    } else {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => {
  console.log("健康伴侣 AI 代理已启动: http://localhost:" + PORT);
  console.log("原型页面: http://localhost:" + PORT + "/");
  console.log("豆包(对话): " + (DOUBAO_KEY ? "已配置(" + DOUBAO_MODEL + ")" : "未配置，将使用演示回复"));
  console.log("DeepSeek(对话): " + (DEEPSEEK_KEY ? "已配置" : "未配置"));
  console.log("千问TTS: " + (DASHSCOPE_KEY ? "已配置 (清新女声等)" : "未配置，自动降级 Edge 晓晓"));
});
