const state = { situation: "", relationship: "", tone: "", closeness: 3 };

function wireGroup(id, key) {
  const group = document.getElementById(id);
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    [...group.children].forEach(c => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    state[key] = btn.dataset.v;
    updateRoomRead();
  });
}
wireGroup("situation", "situation");
wireGroup("tone", "tone");

// 상대 선택
const familySub = document.getElementById("familySub");

document.querySelectorAll("#relationship .chip").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#relationship .chip").forEach(c => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    state.relationship = btn.dataset.v;

    if (btn.dataset.hasSub === "true") {
      familySub.style.display = "flex";
      document.querySelectorAll("#familySub .chip--sub").forEach(c => c.setAttribute("aria-pressed", "false"));
    } else {
      familySub.style.display = "none";
    }
    updateRoomRead();
  });
});

document.querySelectorAll("#familySub .chip--sub").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#familySub .chip--sub").forEach(c => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    state.relationship = "가족·친척(" + btn.dataset.v + ")";
    updateRoomRead();
  });
});

const closenessEl = document.getElementById("closeness");
closenessEl.addEventListener("input", () => {
  state.closeness = +closenessEl.value;
  updateRoomRead();
});

function updateRoomRead() {
  const r = state.relationship, c = state.closeness, t = state.tone;
  let speech = "존댓말", distance, room = "여지는 상황껏";

  if (r === "친구" || r === "가족·친척" || r === "후배") {
    speech = c >= 3 ? "반말" : "편한 존댓말";
  } else if (r === "썸·호감 있는 사이") {
    speech = c >= 4 ? "반말" : "존댓말";
  } else if (r === "직장 상사·동료" || r === "처음 본 사람" || r === "선배") {
    speech = "존댓말";
  } else {
    speech = "존댓말";
  }

  distance = c <= 2 ? "거리감 있게" : c >= 4 ? "편하게" : "적당한 거리";

  if (t === "단호하게") room = "여지 없이";
  else if (t === "부드럽게") room = "부드럽게 여지 남김";
  else if (t === "테토남 스타일") room = "직설적·쿨하게";
  else if (r === "썸·호감 있는 사이") room = "상처 안 주게";
  else if (t === "유머러스하게") room = "가볍게 넘기듯";

  document.getElementById("tagSpeech").textContent = speech;
  document.getElementById("tagDistance").textContent = distance;
  document.getElementById("tagRoom").textContent = room;
}
updateRoomRead();

const goBtn = document.getElementById("goBtn");
const results = document.getElementById("results");

goBtn.addEventListener("click", generate);

async function generate() {
  if (!state.situation || !state.relationship || !state.tone) {
    results.hidden = false;
    results.innerHTML = '<div class="error">상황 · 상대 · 느낌을 모두 골라주세요</div>';
    return;
  }
  const theirMsg = document.getElementById("theirMsg").value.trim();

  goBtn.disabled = true;
  goBtn.textContent = "만드는 중…";
  results.hidden = false;
  results.innerHTML = '<div class="loading">상대 마음 덜 다치게 다듬는 중<span class="dots"></span></div>';

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        situation: state.situation,
        relationship: state.relationship,
        closeness: state.closeness,
        tone: state.tone,
        theirMsg,
      }),
    });
    const data = await res.json();

    if (res.status === 429) {
      results.innerHTML = '<div class="error">' + escapeHtml(data.error || "오늘 사용 한도를 초과했어요.") + '</div>';
      return;
    }
    if (!res.ok) throw new Error(data.error || "서버 오류");

    render(data.messages || [], data.remaining);
  } catch (err) {
    results.innerHTML = '<div class="error">멘트를 만들지 못했어요. 잠시 후 다시 시도해주세요.</div>' +
      '<button class="again" id="retry">다시 만들기</button>';
    const rt = document.getElementById("retry");
    if (rt) rt.addEventListener("click", generate);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "거절 멘트 만들기";
  }
}

function render(messages, remaining) {
  if (!messages.length) {
    results.innerHTML = '<div class="error">결과가 비었어요. 다시 시도해주세요.</div>';
    return;
  }
  const remainingHtml = remaining != null
    ? '<p class="remaining">오늘 남은 무료 횟수: <strong>' + remaining + '회</strong></p>'
    : '';
  let html = remainingHtml + '<p class="results-head">— 골라서 보내세요 —</p>';
  messages.forEach((m, i) => {
    const safe = escapeHtml(m.text || "");
    html +=
      '<div class="note">' +
        '<div class="label">' + escapeHtml(m.label || ("버전 " + (i + 1))) + '</div>' +
        '<div class="body">' + safe + '</div>' +
        '<div class="actions"><button class="copy" data-text="' + encodeURIComponent(m.text || "") + '">복사</button></div>' +
      '</div>';
  });
  html += '<button class="again" id="again">조건 바꿔 다시 만들기</button>';
  results.innerHTML = html;

  results.querySelectorAll(".copy").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = decodeURIComponent(btn.dataset.text);
      navigator.clipboard.writeText(t).then(() => {
        btn.textContent = "복사됨"; btn.classList.add("done");
        setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("done"); }, 1400);
      });
    });
  });
  const again = document.getElementById("again");
  if (again) again.addEventListener("click", () => {
    results.scrollIntoView({ behavior: "smooth", block: "start" });
    generate();
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
