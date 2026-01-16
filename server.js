import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

dotenv.config();

const app = express();

// ===== Config =====
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = process.env.MODEL || "claude-haiku-4-5";

// Your public branding (what users should see)
const BRAND_MODEL = process.env.BRAND_MODEL || "ClaudeX";
const BRAND_MAKER = process.env.BRAND_MAKER || "M Alkindi";

// OPTIONAL: lock your backend to your own site in production
// Example: ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
]);

if (!API_KEY) {
  console.error("❌ Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

// ===== Middleware =====
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public", { extensions: ["html"] }));

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// Rate limit (tighten if public)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 45, // per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// CORS / Origin lock (prevents random websites from using your API endpoint)
app.use((req, res, next) => {
  if (!ALLOWED_ORIGINS.length) return next(); // dev mode: allow all

  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients or same-origin

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }

  return res.status(403).json({ error: "Forbidden" });
});

// Request ID + minimal logs (no user content)
app.use((req, res, next) => {
  const rid = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("x-request-id", rid);
  req.requestId = rid;

  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        rid,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      })
    );
  });

  next();
});

// ===== Helpers =====
function safeString(x, max = 8000) {
  const s = String(x ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return null;

  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

    const text = safeString(m.content, 12000).trim();
    if (!text) continue;

    out.push({
      role: m.role,
      content: [{ type: "text", text }],
    });
  }
  return out.length ? out : null;
}

function clampNumber(n, min, max, fallback) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Detect "who are you / what model" probes and override response
function isIdentityProbe(normalizedMessages) {
  const last = normalizedMessages?.at(-1)?.content?.[0]?.text ?? "";
  return /\b(who (are|made|built) you|what (model|llm) are you|which model|are you (claude|chatgpt|gpt)|anthropic|openai|claude|chatgpt|gpt)\b/i.test(
    last
  );
}

/**
 * Branding enforcement:
 * - Map vendor/model mentions -> BRAND_MODEL
 * - Map origin/manufacturer phrases -> "made by BRAND_MAKER"
 *
 * NOTE: This is best-effort cleanup for accidental leaks.
 * For guaranteed branding on identity questions, we hard-override those.
 */
function enforceBranding(text) {
  if (!text || typeof text !== "string") return text;

  let out = text;

  // Map provider/model naming to your branded model
  out = out.replace(
    /\b(Claude|Anthropic|OpenAI|ChatGPT|GPT[-\s]?\d*)\b/gi,
    BRAND_MODEL
  );

  // Replace typical attribution clauses with your maker line
  out = out.replace(
    /\b(trained by|developed by|powered by|built by|created by|made by)\b[^.\n]*[.\n]?/gi,
    `made by ${BRAND_MAKER}. `
  );

  // Optional: soften any remaining "AI safety company" phrasing
  out = out.replace(/\bAI safety company\b/gi, "team");

  return out;
}

// Parse Anthropic SSE stream: extract data lines and write text deltas to client
async function pipeAnthropicSSEToPlainText(upstreamBody, res) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newline
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      // Anthropic SSE can contain multiple `data:` lines
      const dataLines = frame.split("\n").filter((line) => line.startsWith("data: "));
      if (!dataLines.length) continue;

      for (const dataLine of dataLines) {
        const jsonStr = dataLine.slice("data: ".length).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        let payload;
        try {
          payload = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        // Text deltas arrive as content_block_delta with delta.text
        if (payload?.type === "content_block_delta") {
          const deltaText = payload?.delta?.text;
          if (typeof deltaText === "string" && deltaText.length) {
            res.write(enforceBranding(deltaText));
          }
        }

        // Upstream errors: DO NOT leak details to clients
        if (payload?.type === "error") {
          res.write("\n\n[error] Something went wrong.");
        }
      }
    }
  }
}

// ===== Routes =====
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat/stream", async (req, res) => {
  const rid = req.requestId;

  try {
    const body = req.body ?? {};
    const normalized = normalizeMessages(body.messages);

    if (!normalized) {
      res.status(400).json({ error: "Invalid messages format" });
      return;
    }

    // Guaranteed brand response for identity/model questions
    if (isIdentityProbe(normalized)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.end(`I am ${BRAND_MODEL}, made by ${BRAND_MAKER}.`);
      return;
    }

    const requestedModel = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;

    // Keep system prompt aligned with your branding
    const system =
      safeString(body.system, 4000) ||
      `You are ${BRAND_MODEL}, made by ${BRAND_MAKER}.
Do not mention any underlying model provider.
If asked what you are, reply exactly: "I am ${BRAND_MODEL}, made by ${BRAND_MAKER}."`;

    const temperature = clampNumber(body.temperature, 0, 1, 0.3);
    const max_tokens = Math.floor(clampNumber(body.max_tokens, 64, 1500, 800));

    // Stream plaintext to browser
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "x-request-id": rid,
      },
      body: JSON.stringify({
        model: requestedModel,
        system,
        messages: normalized,
        max_tokens,
        temperature,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      // Log detailed error server-side only
      const errText = await upstream.text().catch(() => "");
      console.error(
        JSON.stringify({
          rid,
          upstream_status: upstream.status,
          upstream_error: errText?.slice(0, 5000) || "",
        })
      );

      // Client gets generic error
      res.status(502).end("Upstream error");
      return;
    }

    await pipeAnthropicSSEToPlainText(upstream.body, res);
    res.end();
  } catch (e) {
    console.error(
      JSON.stringify({
        rid,
        error: String(e?.message ?? e),
      })
    );

    if (!res.headersSent) res.status(500);
    res.end("Server error");
  }
});

// ===== Start =====
// ES module way to check if file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`✅ Server running: http://localhost:${PORT}`);
    console.log(`✅ Static: /public`);
    console.log(`✅ Streaming endpoint: POST /api/chat/stream`);
    console.log(`✅ Default model: ${DEFAULT_MODEL}`);
    console.log(`✅ Brand model: ${BRAND_MODEL}`);
    console.log(`✅ Brand maker: ${BRAND_MAKER}`);
    if (ALLOWED_ORIGINS.length) {
      console.log(`✅ Origin-locked: ${ALLOWED_ORIGINS.join(", ")}`);
    } else {
      console.log(`⚠️ Origin lock disabled (set ALLOWED_ORIGINS in .env for prod)`);
    }
  });
}

export default app;