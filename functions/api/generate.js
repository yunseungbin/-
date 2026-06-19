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

  // KV 캐시 조회 (theirMsg 없을 때만)
  if (!personalized && env.CACHE) {
    const cached = await env.CACHE.get(cacheKey, { type: "json" });
    if (cached && cached.length > 0) {
      const pick = cached[Math.floor(Math.random() * cached.length)];
      return Response.json({ messages: pick, fromCache: true });
    }
  }

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

    // KV 캐시 저장 (최대 15개 변형)
    if (!personalized && env.CACHE) {
      const existing = (await env.CACHE.get(cacheKey, { type: "json" })) || [];
      if (existing.length < 15) {
        existing.push(messages);
        await env.CACHE.put(cacheKey, JSON.stringify(existing), {
          expirationTtl: 60 * 60 * 24 * 30, // 30일
        });
      }
    }

    return Response.json({ messages });
  } catch (err) {
    return Response.json({ error: "멘트 생성 실패" }, { status: 500 });
  }
}
