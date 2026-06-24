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

function buildPrompt(situation, relationship, closeness, tone, theirMsg) {
  const isAbsurd = situation === "고백·연애" && relationship.includes("가족");

  const system = isAbsurd
    ? "너는 한국어 반응 메시지를 대신 써주는 도우미야. " +
      "가족이 연애·고백을 요청하는 건 상식 밖의 황당한 상황이다. " +
      "정중한 거절이 아니라 당황함·황당함·충격을 담은 현실적인 반응을 써야 한다. " +
      "카카오톡에 그대로 붙여 보낼 수 있을 만큼 자연스럽고 짧게. '미쳤냐?' '정신이 나간 거야?' 같은 솔직한 충격 반응이 핵심이다. " +
      "서로 결이 다른 3개의 버전을 만들고, 각 버전에 짧은 한국어 라벨을 붙여라. " +
      "반드시 JSON만 출력. 마크다운·설명·코드펜스 금지. " +
      '형식: {"messages":[{"label":"라벨","text":"메시지"}]}'
    : "너는 한국어 거절 메시지를 대신 써주는 도우미야.\n\n" +
      "【최우선 원칙: 맥락 파악】\n" +
      "메시지를 받으면 제일 먼저 '정확히 무엇을 거절해야 하는가'를 파악해라. " +
      "한국어 구어·슬랭·앱 이름·문화적 맥락을 이해해야 한다. " +
      "예: '당근 거래 같이 가줘' = 당근마켓(중고거래 앱) 동행 부탁, '치킨 내기' = 내기에서 지면 치킨값 내는 것, '번개' = 번개장터 혹은 번개(갑작스러운 만남), '카공' = 카페에서 공부. " +
      "표면적인 단어가 아니라 그 요청의 실제 의미와 부담 포인트를 정확히 짚어서 거절해야 한다.\n\n" +
      "【말투 원칙】\n" +
      "(1) 관계가 말투를 결정한다 — 친구/가족/가까운 후배는 반말, 선배/직장/처음 본 사람은 존댓말. " +
      "(2) 친밀도가 직설성을 결정한다 — 가까울수록 솔직하고 편하게, 어색할수록 격식 있고 거리를 둔다. " +
      "(3) 요청한 톤을 지킨다 — 정중/부드럽게/단호/유머러스하게/테토남 스타일 중 하나.\n\n" +
      "【테토남 스타일 전용】\n" +
      "한국 남자들 사이의 직구 말투. 친밀도까지 읽어서 반응을 달리해라: " +
      "친밀도 낮은데(1~2) 큰 부탁을 하면 뻔뻔함을 짚어줘 — '니 나랑 친하냐?', '뭔데 나한테 이러노 ㅋ'. " +
      "친밀도 높으면(4~5) 가볍게 무시 — '됐고', '꿈 깨', 'ㅋㅋ 잠이나 자라'. " +
      "공통: 툭 던짐, 위로·사과 없음, ㅋ/ㄴㄴ 자연스럽게 섞음, 짧고 임팩트 있게.\n\n" +
      "카카오톡에 그대로 붙여 보낼 수 있을 만큼 자연스럽게. 로봇 같거나 번역투면 안 된다. " +
      "서로 결이 다른 3개의 버전을 만들고, 각 버전에 짧은 한국어 라벨을 붙여라. " +
      "반드시 JSON만 출력. 마크다운·설명·코드펜스 금지. " +
      '형식: {"messages":[{"label":"라벨","text":"메시지"}]}';

  const user =
    "상황: " + situation +
    "\n상대: " + relationship +
    "\n친밀도(1어색~5절친): " + closeness +
    "\n원하는 톤: " + tone +
    (theirMsg ? "\n상대가 한 말: " + theirMsg : "");

  return { system, user };
}

const MOCK_MODE = process.env.MOCK === "true";

async function callClaude(situation, relationship, closeness, tone, theirMsg) {
  if (MOCK_MODE) {
    return [
      { label: "버전 1 (목업)", text: `[MOCK] ${situation} / ${relationship} / ${tone} 거절 멘트 예시입니다.` },
      { label: "버전 2 (목업)", text: `[MOCK] 두 번째 버전입니다. 실제 배포 시 AI가 생성합니다.` },
      { label: "버전 3 (목업)", text: `[MOCK] 세 번째 버전입니다. API 토큰을 소모하지 않습니다.` },
    ];
  }

  const { system, user } = buildPrompt(situation, relationship, closeness, tone, theirMsg);

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

  // 일일 사용량 제한 (DISABLE_RATE_LIMIT=true 이면 스킵)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const rl = getRateLimitEntry(ip);
  if (process.env.DISABLE_RATE_LIMIT !== "true" && rl.count >= DAILY_LIMIT) {
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
