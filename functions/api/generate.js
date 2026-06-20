const DAILY_LIMIT = 10;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const { situation, relationship, closeness, tone, theirMsg } = body;

  if (!situation || !relationship || !tone) {
    return Response.json({ error: "필수 항목 누락" }, { status: 400 });
  }

  const personalized = !!theirMsg;
  const cacheKey = `${situation}|${relationship}|${closeness}|${tone}`;

  // KV 캐시 조회 (theirMsg 없을 때만) — 캐시 히트는 API 호출 없음 → 한도 차감 안 함
  if (!personalized && env.CACHE) {
    const cached = await env.CACHE.get(cacheKey, { type: "json" });
    if (cached && cached.length > 0) {
      const pick = cached[Math.floor(Math.random() * cached.length)];
      return Response.json({ messages: pick, fromCache: true });
    }
  }

  // 일일 사용량 제한 (KV 있을 때만 적용)
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const rlKey = `rl|${ip}|${dateStr}`;
  let usedToday = 0;

  if (env.CACHE) {
    usedToday = (await env.CACHE.get(rlKey, { type: "json" })) || 0;
    if (usedToday >= DAILY_LIMIT) {
      return Response.json(
        { error: `오늘 무료 횟수(${DAILY_LIMIT}회)를 모두 썼어요. 자정 이후에 다시 사용할 수 있어요.`, rateLimited: true },
        { status: 429 }
      );
    }
  }

  const isAbsurd = situation === "고백·연애" && relationship.includes("가족");

  const system = isAbsurd
    ? "너는 한국어 반응 메시지를 대신 써주는 도우미야. " +
      "가족이 연애·고백을 요청하는 건 상식 밖의 황당한 상황이다. " +
      "정중한 거절이 아니라 당황함·황당함·충격을 담은 현실적인 반응을 써야 한다. " +
      "카카오톡에 그대로 붙여 보낼 수 있을 만큼 자연스럽고 짧게. '미쳤냐?' '정신이 나간 거야?' 같은 솔직한 충격 반응이 핵심이다. " +
      "서로 결이 다른 3개의 버전을 만들고, 각 버전에 짧은 한국어 라벨을 붙여라. " +
      "반드시 JSON만 출력. 마크다운·설명·코드펜스 금지. " +
      '형식: {"messages":[{"label":"라벨","text":"메시지"}]}'
    : "너는 한국어 거절 메시지를 대신 써주는 도우미야. 핵심 원칙: " +
      "(1) 관계가 말투를 결정한다 — 친구/가족/가까운 후배는 반말, 선배/직장/처음 본 사람은 존댓말. " +
      "(2) 친밀도가 직설성을 결정한다 — 가까울수록 솔직하고 편하게, 어색할수록 격식 있고 거리를 둔다. " +
      "(3) 요청한 톤을 지킨다 — 정중/부드럽게/단호/유머러스하게/테토남 스타일 중 하나. " +
      "특히 '테토남 스타일'은 테스토스테론형 직남 말투: 군더더기 없이 짧고 직설적, 쿨하게 선 긋기, 사과·변명 최소화, 감정 표현 절제, 그냥 '안 돼' '힘들 것 같아' 식의 간결한 거절. " +
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

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    const data = await res.json();
    const raw = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();
    const messages = JSON.parse(raw).messages || [];

    // KV 캐시 저장 (최대 15개 변형) + 사용량 카운터 증가
    if (env.CACHE) {
      if (!personalized) {
        const existing = (await env.CACHE.get(cacheKey, { type: "json" })) || [];
        if (existing.length < 15) {
          existing.push(messages);
          await env.CACHE.put(cacheKey, JSON.stringify(existing), {
            expirationTtl: 60 * 60 * 24 * 30, // 30일
          });
        }
      }

      // 사용량 +1
      await env.CACHE.put(rlKey, JSON.stringify(usedToday + 1), {
        expirationTtl: 60 * 60 * 48, // 48시간 (다음날 자정까지 유지)
      });
    }

    const remaining = env.CACHE ? Math.max(0, DAILY_LIMIT - (usedToday + 1)) : null;

    return Response.json({ messages, remaining });
  } catch (err) {
    return Response.json({ error: "멘트 생성 실패" }, { status: 500 });
  }
}
