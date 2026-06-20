require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("."));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 캐시: 조합별로 최대 VARIANTS_PER_KEY개 변형을 저장, 랜덤으로 꺼내줌
const cache = new Map();
const CACHE_MAX_KEYS = 500;
const VARIANTS_PER_KEY = 15;

// 일일 사용량 제한
const rateLimits = new Map(); // ip -> { count, date }
const DAILY_LIMIT = 10;

function getRateLimitEntry(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = rateLimits.get(ip);
  if (!entry || entry.date !== today) {
    const fresh = { count: 0, date: today };
    rateLimits.set(ip, fresh);
    return fresh;
  }
  return entry;
}

function cacheKey(situation, relationship, closeness, tone) {
  return `${situation}|${relationship}|${closeness}|${tone}`;
}

async function callClaude(situation, relationship, closeness, tone, theirMsg) {
  const system =
    "너는 한국어 거절 메시지를 대신 써주는 도우미야. 핵심 원칙: " +
    "(1) 관계가 말투를 결정한다 — 친구/가족/가까운 후배는 반말, 선배/직장/처음 본 사람은 존댓말. " +
    "(2) 친밀도가 직설성을 결정한다 — 가까울수록 솔직하고 편하게, 어색할수록 격식 있고 거리를 둔다. " +
    "(3) 요청한 톤(정중/부드럽게/단호/유머)을 지킨다. " +
    "메시지는 카카오톡에 그대로 붙여 보낼 수 있을 만큼 자연스럽게. 로봇 같거나 번역투면 안 된다. " +
    "과한 사과나 변명은 빼고, 거절은 분명히 하되 관계는 상하지 않게. " +
    "서로 결이 다른 3개의 버전을 만들고, 각 버전에 짧은 한국어 라벨을 붙여라. " +
    "반드시 JSON만 출력. 마크다운·설명·코드펜스 금지. " +
    '형식: {"messages":[{"label":"라벨","text":"메시지"}]}';

  const user =
    "상황: " + situation +
    "\n상대: " + relationship +
    "\n친밀도(1어색~5절친): " + closeness +
    "\n원하는 톤: " + tone +
    (theirMsg ? "\n상대가 한 말: " + theirMsg : "");

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const raw = (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  return JSON.parse(raw).messages || [];
}

app.post("/api/generate", async (req, res) => {
  const { situation, relationship, closeness, tone, theirMsg } = req.body;

  if (!situation || !relationship || !tone) {
    return res.status(400).json({ error: "필수 항목 누락" });
  }

  const personalized = !!theirMsg;

  // 캐시 히트 → API 호출 없음 → 한도 차감 안 함
  if (!personalized) {
    const key = cacheKey(situation, relationship, closeness, tone);
    const entry = cache.get(key);
    if (entry && entry.length > 0) {
      const pick = entry[Math.floor(Math.random() * entry.length)];
      return res.json({ messages: pick, fromCache: true });
    }
  }

  // 일일 사용량 제한
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const rl = getRateLimitEntry(ip);
  if (rl.count >= DAILY_LIMIT) {
    return res.status(429).json({
      error: `오늘 무료 횟수(${DAILY_LIMIT}회)를 모두 썼어요. 자정 이후에 다시 사용할 수 있어요.`,
      rateLimited: true,
    });
  }

  try {
    const messages = await callClaude(situation, relationship, closeness, tone, theirMsg);

    rl.count += 1;

    if (!personalized) {
      const key = cacheKey(situation, relationship, closeness, tone);
      const entry = cache.get(key) || [];
      if (entry.length < VARIANTS_PER_KEY) {
        entry.push(messages);
        cache.set(key, entry);
      }
      if (cache.size > CACHE_MAX_KEYS) {
        cache.delete(cache.keys().next().value);
      }
    }

    res.json({ messages, remaining: DAILY_LIMIT - rl.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "멘트 생성 실패" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중 → http://localhost:${PORT}`));
