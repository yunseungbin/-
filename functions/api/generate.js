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
