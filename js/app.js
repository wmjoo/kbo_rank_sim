const TEAM_COLORS = {
  KT: "#111111",
  삼성: "#074CA1",
  LG: "#C30452",
  KIA: "#EA0029",
  두산: "#1A1748",
  NC: "#315288",
  SSG: "#CE0E2D",
  롯데: "#041E42",
  한화: "#FF6600",
  키움: "#570514",
};

const SEASON_GAMES = 144;
const SOURCES = {
  rank: "https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx",
  hitter: "https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx",
  pitcher: "https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx",
};

const PROXY_PREFIXES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const state = {
  data: null,
  source: "snapshot",
  sim: [],
};

function $(id) {
  return document.getElementById(id);
}

function teamDot(name) {
  const color = TEAM_COLORS[name] || "#888";
  return `<span class="team-cell"><span class="dot" style="background:${color}"></span>${escapeHtml(name)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function padRow(row, width) {
  const next = row.slice();
  while (next.length < width) next.push("");
  return next.slice(0, width);
}

function renderTable(el, rows, opts = {}) {
  if (!rows || rows.length < 2) {
    el.innerHTML = `<p class="empty">표를 불러오지 못했습니다.</p>`;
    return;
  }

  const header = rows[0];
  const width = header.length;
  const sticky = opts.stickyCols ?? 2;
  const teamIdx = header.findIndex((h) => h === "팀명");
  const rankIdx = header.findIndex((h) => h === "순위");

  const headHtml = header
    .map((cell, i) => {
      const cls = [
        i < sticky ? `sticky-${i + 1}` : "",
        i === teamIdx ? "team" : "",
        i === rankIdx ? "rank" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<th class="${cls}">${escapeHtml(cell)}</th>`;
    })
    .join("");

  const bodyHtml = rows
    .slice(1)
    .map((raw) => {
      const row = padRow(raw, width);
      const isTotal = row[0] === "합계";
      const tds = row
        .map((cell, i) => {
          const cls = [
            i < sticky ? `sticky-${i + 1}` : "",
            i === teamIdx ? "team" : "",
            i === rankIdx ? "rank" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const inner = i === teamIdx && cell && !isTotal ? teamDot(cell) : escapeHtml(cell);
          return `<td class="${cls}">${inner}</td>`;
        })
        .join("");
      return `<tr class="${isTotal ? "total" : ""}">${tds}</tr>`;
    })
    .join("");

  el.innerHTML = `<div class="table-wrap"><table class="slim"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function parseRank(rows) {
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).map((row) => {
    const name = row[1];
    const g = Number(row[2]);
    const w = Number(row[3]);
    const l = Number(row[4]);
    const t = Number(row[5]);
    return {
      name,
      g0: g,
      w0: w,
      l0: l,
      t0: t,
      addW: 0,
      addL: 0,
      addT: 0,
      remain0: Math.max(0, SEASON_GAMES - g),
    };
  });
}

function pct(w, l) {
  const d = w + l;
  return d === 0 ? 0 : w / d;
}

function formatPct(value) {
  return value.toFixed(3);
}

function gameBehind(leader, team) {
  return ((leader.w - team.w) + (team.l - leader.l)) / 2;
}

function computedTeams() {
  const teams = state.sim.map((t) => {
    const w = t.w0 + t.addW;
    const l = t.l0 + t.addL;
    const d = t.t0 + t.addT;
    const g = t.g0 + t.addW + t.addL + t.addT;
    const remain = t.remain0 - t.addW - t.addL - t.addT;
    return {
      ...t,
      w,
      l,
      d,
      g,
      remain,
      pct: pct(w, l),
      used: t.addW + t.addL + t.addT,
    };
  });

  teams.sort((a, b) => b.pct - a.pct || b.w - a.w || a.l - b.l);
  const leader = teams[0];
  return teams.map((t, i) => ({
    ...t,
    rank: i + 1,
    gb: i === 0 ? 0 : gameBehind(leader, t),
  }));
}

function renderSim() {
  const teams = computedTeams();
  if (!teams.length) {
    $("sim-table").innerHTML = `<p class="empty">순위 데이터를 불러오지 못했습니다.</p>`;
    return;
  }

  const rows = teams
    .map((t) => {
      const moved = t.rank < Number(state.data.rank.find((r) => r[1] === t.name)?.[0] || t.rank)
        ? "moved-up"
        : t.rank > Number(state.data.rank.find((r) => r[1] === t.name)?.[0] || t.rank)
          ? "moved-down"
          : "";
      const cut = t.rank === 5 ? "cut" : "";
      const disabled = t.remain <= 0 ? "disabled" : "";
      const canUndo = t.used > 0 ? "" : "disabled";
      return `<tr class="${[moved, cut].filter(Boolean).join(" ")}">
        <td class="rank sticky-1">${t.rank}</td>
        <td class="team sticky-2">${teamDot(t.name)}</td>
        <td>${t.g}</td>
        <td>${t.w}</td>
        <td>${t.l}</td>
        <td>${t.d}</td>
        <td>${formatPct(t.pct)}</td>
        <td>${t.gb === 0 ? "-" : t.gb.toFixed(1)}</td>
        <td>${t.remain}</td>
        <td>
          <div class="mini-btns">
            <button class="chip win" data-act="W" data-team="${escapeHtml(t.name)}" ${disabled}>승</button>
            <button class="chip loss" data-act="L" data-team="${escapeHtml(t.name)}" ${disabled}>패</button>
            <button class="chip tie" data-act="T" data-team="${escapeHtml(t.name)}" ${disabled}>무</button>
            <button class="chip undo" data-act="U" data-team="${escapeHtml(t.name)}" ${canUndo}>↩</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  $("sim-table").innerHTML = `<div class="table-wrap"><table class="slim">
    <thead><tr>
      <th class="rank sticky-1">순위</th>
      <th class="team sticky-2">팀명</th>
      <th>경기</th><th>승</th><th>패</th><th>무</th>
      <th>승률</th><th>게임차</th><th>잔여</th><th>배정</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function applyResult(name, act) {
  const team = state.sim.find((t) => t.name === name);
  if (!team) return;
  const used = team.addW + team.addL + team.addT;
  if (act === "U") {
    if (team.addT) team.addT -= 1;
    else if (team.addL) team.addL -= 1;
    else if (team.addW) team.addW -= 1;
  } else if (used < team.remain0) {
    if (act === "W") team.addW += 1;
    if (act === "L") team.addL += 1;
    if (act === "T") team.addT += 1;
  }
  renderSim();
}

function resetSim() {
  state.sim.forEach((t) => {
    t.addW = 0;
    t.addL = 0;
    t.addT = 0;
  });
  renderSim();
}

function renderRecords() {
  const data = state.data;
  $("asof").textContent = data.asOfLabel || "";
  renderTable($("rank-table"), data.rank);
  renderTable($("hitter-table"), data.hitter);
  renderTable($("pitcher-table"), data.pitcher);
}

function setStatus(kind, text) {
  const el = $("data-status");
  el.className = kind === "live" ? "status-live" : "status-snap";
  el.textContent = text;
}

function parseHtmlTables(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table.tData, table");
  if (!table) return [];
  return [...table.rows].map((tr) =>
    [...tr.cells].flatMap((td) => {
      const span = Number(td.colSpan || 1);
      const text = td.textContent.replace(/\s+/g, " ").trim();
      return Array.from({ length: span }, (_, i) => (i === 0 ? text : ""));
    })
  );
}

async function fetchViaProxy(url) {
  let lastError;
  for (const make of PROXY_PREFIXES) {
    try {
      const res = await fetch(make(url), { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      const rows = parseHtmlTables(html);
      if (rows.length < 2) throw new Error("empty table");
      return { html, rows };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function asOfFromHtml(html) {
  const m = html.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) return { asOf: null, asOfLabel: "" };
  return {
    asOf: `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`,
    asOfLabel: `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일 기준`,
  };
}

async function importLive() {
  setStatus("snap", "KBO 기록실에서 가져오는 중…");
  const [rank, hitter, pitcher] = await Promise.all([
    fetchViaProxy(SOURCES.rank),
    fetchViaProxy(SOURCES.hitter),
    fetchViaProxy(SOURCES.pitcher),
  ]);
  const asof = asOfFromHtml(rank.html);
  return {
    asOf: asof.asOf,
    asOfLabel: asof.asOfLabel,
    sources: SOURCES,
    rank: rank.rows,
    hitter: hitter.rows,
    pitcher: pitcher.rows,
  };
}

async function loadSnapshot() {
  const res = await fetch("data/kbo.json", { cache: "no-store" });
  if (!res.ok) throw new Error("snapshot missing");
  return res.json();
}

function applyData(data, source) {
  state.data = data;
  state.source = source;
  state.sim = parseRank(data.rank);
  if (source === "live") {
    setStatus("live", `라이브 · ${data.asOfLabel || "방금 가져옴"}`);
  } else {
    setStatus("snap", `스냅샷 · ${data.asOfLabel || ""}`);
  }
  $("asof").textContent = data.asOfLabel || "";
  renderSim();
  renderRecords();
}

async function boot() {
  const snapshot = await loadSnapshot();
  applyData(snapshot, "snapshot");
  try {
    const live = await importLive();
    applyData(live, "live");
  } catch {
    setStatus("snap", `스냅샷 · ${snapshot.asOfLabel || ""}`);
  }
}

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  history.replaceState(null, "", name === "records" ? "#records" : "#sim");
}

function bind() {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  $("sim-table").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    applyResult(btn.dataset.team, btn.dataset.act);
  });
  $("reset-sim").addEventListener("click", resetSim);
  $("reload-data").addEventListener("click", async () => {
    $("reload-data").disabled = true;
    try {
      const live = await importLive();
      applyData(live, "live");
    } catch {
      setStatus("snap", `스냅샷 유지 · ${state.data?.asOfLabel || ""}`);
    } finally {
      $("reload-data").disabled = false;
    }
  });
  setTab(location.hash === "#records" ? "records" : "sim");
}

bind();
boot();
