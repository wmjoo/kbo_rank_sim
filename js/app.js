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
const GAMES_PER_OPPONENT = 16;
const FOCUS_TEAM = "LG";
const RACE_TEAMS = ["KT", "삼성", "LG", "KIA"];
const MC_METRICS = [
  { key: "binom", label: "이항", prior: "현재 승률", expected: "binomFinalPct" },
  { key: "pyth", label: "피타", prior: "피타고리안", expected: "pythFinalPct" },
  { key: "versus", label: "상대전적", prior: "상대별 승률", expected: "versusFinalPct" },
];
const REPO = { owner: "wmjoo", name: "kbo_rank_sim", branch: "main" };
const TOKEN_KEY = "kbo.githubToken";

const SOURCES = {
  rank: "https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx",
  hitter: "https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx",
  pitcher: "https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx",
};

function getToken() {
  return ($("gh-token").value || localStorage.getItem(TOKEN_KEY) || "").replace(/\s+/g, "");
}

function fetchTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

async function fetchViaProxy(url) {
  const attempts = [
    async () => {
      const t = fetchTimeout(15000);
      try {
        const res = await fetch(`https://r.jina.ai/${url}`, {
          cache: "no-store",
          signal: t.signal,
          headers: { "X-Return-Format": "html" },
        });
        if (!res.ok) throw new Error(`jina ${res.status}`);
        return res.text();
      } finally {
        t.clear();
      }
    },
    async () => {
      const t = fetchTimeout(12000);
      try {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
          cache: "no-store",
          signal: t.signal,
        });
        if (!res.ok) throw new Error(`allorigins ${res.status}`);
        return res.text();
      } finally {
        t.clear();
      }
    },
  ];
  let lastError;
  for (const run of attempts) {
    try {
      const html = await run();
      const tables = parseAllTables(html);
      if (!tables.length) throw new Error("empty table");
      return { html, tables, rows: tables[0] };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const state = {
  data: null,
  source: "snapshot",
  sim: [],
  mc: null,
  sorts: {
    sim: { key: "rank", dir: "asc" },
    rank: { col: 0, dir: "asc" },
    hitter: { col: 0, dir: "asc" },
    pitcher: { col: 0, dir: "asc" },
    h2h: { col: 0, dir: "asc" },
  },
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function teamDot(name) {
  const color = TEAM_COLORS[name] || "#888";
  return `<span class="team-cell"><span class="dot" style="background:${color}"></span>${escapeHtml(name)}</span>`;
}

function padRow(row, width) {
  const next = row.slice();
  while (next.length < width) next.push("");
  return next.slice(0, width);
}

function pct(w, l) {
  const d = w + l;
  return d === 0 ? 0 : w / d;
}

function formatPct(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "-";
}

function teamTint(name) {
  const hex = TEAM_COLORS[name] || "#888888";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { border: hex, bg: `rgba(${r},${g},${b},0.12)` };
}

function pythagorean(rs, ra) {
  const a = rs * rs;
  const b = ra * ra;
  return a + b === 0 ? 0 : a / (a + b);
}

function colIndex(header, name) {
  return header.findIndex((h) => h === name);
}

function teamStatMap(rows, statName) {
  if (!rows || rows.length < 2) return {};
  const header = rows[0];
  const teamIdx = colIndex(header, "팀명");
  const statIdx = colIndex(header, statName);
  if (teamIdx < 0 || statIdx < 0) return {};
  const map = {};
  rows.slice(1).forEach((row) => {
    const team = row[teamIdx];
    if (!team) return;
    map[team] = Number(row[statIdx]);
  });
  return map;
}

function parseRank(rows) {
  if (!rows || rows.length < 2) return [];
  const runsFor = teamStatMap(state.data?.hitter, "R");
  const runsAgainst = teamStatMap(state.data?.pitcher, "R");
  return rows.slice(1).map((row) => {
    const name = row[1];
    const g = Number(row[2]);
    const w = Number(row[3]);
    const l = Number(row[4]);
    const t = Number(row[5]);
    const rs = runsFor[name];
    const ra = runsAgainst[name];
    return {
      name,
      g,
      w,
      l,
      t,
      remain: Math.max(0, SEASON_GAMES - g),
      pyth: Number.isFinite(rs) && Number.isFinite(ra) ? pythagorean(rs, ra) : 0,
    };
  });
}

function rankBy(teams, key) {
  const ordered = [...teams].sort((a, b) => b[key] - a[key] || b.w - a.w || a.l - b.l);
  const ranks = {};
  ordered.forEach((t, i) => {
    ranks[t.name] = i + 1;
  });
  return ranks;
}

function binomModeWins(n, p) {
  if (n <= 0) return 0;
  return Math.min(n, Math.max(0, Math.round(n * p)));
}

function versusExpectedWins(teamName, fallbackPct, remain) {
  const items = remainingOpponents(teamName);
  let exp = 0;
  let accounted = 0;
  items.forEach((x) => {
    const p = x.w + x.l === 0 ? fallbackPct : x.wp;
    exp += x.remain * p;
    accounted += x.remain;
  });
  exp += Math.max(0, remain - accounted) * fallbackPct;
  return exp;
}

function computedTeams() {
  const teams = state.sim.map((t) => {
    const curPct = pct(t.w, t.l);
    const denom = t.w + t.l + t.remain;
    const likelyW = binomModeWins(t.remain, curPct);
    const binomFinalPct = pct(t.w + likelyW, t.l + (t.remain - likelyW));
    const pythFinalPct = denom === 0 ? t.pyth : (t.w + t.remain * t.pyth) / denom;
    const vsExp = versusExpectedWins(t.name, curPct, t.remain);
    const versusFinalPct = denom === 0 ? curPct : (t.w + vsExp) / denom;
    return { ...t, pct: curPct, likelyW, vsExp, binomFinalPct, pythFinalPct, versusFinalPct };
  });
  const binomRank = rankBy(teams, "binomFinalPct");
  const pythRank = rankBy(teams, "pythFinalPct");
  const versusRank = rankBy(teams, "versusFinalPct");
  const standings = [...teams].sort((a, b) => b.pct - a.pct || b.w - a.w || a.l - b.l);
  return teams.map((t) => ({
    ...t,
    rank: standings.findIndex((x) => x.name === t.name) + 1,
    binomRank: binomRank[t.name],
    pythRank: pythRank[t.name],
    versusRank: versusRank[t.name],
  }));
}

function sortRows(rows, key, dir, getValue) {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = getValue(a, key);
    const vb = getValue(b, key);
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
    return String(va).localeCompare(String(vb), "ko") * sign;
  });
}

function toggleSort(store, key, defaultDir = "desc") {
  if (store.key === key || store.col === key) {
    store.dir = store.dir === "asc" ? "desc" : "asc";
  } else if (typeof key === "number") {
    store.col = key;
    store.dir = defaultDir;
  } else {
    store.key = key;
    store.dir = defaultDir;
  }
}

function th(label, opts = {}) {
  const cls = [
    opts.cls || "",
    opts.sortKey != null || opts.sortCol != null ? "sortable" : "",
    opts.sorted ? "sorted" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const data =
    opts.sortKey != null
      ? `data-sort-key="${opts.sortKey}"`
      : opts.sortCol != null
        ? `data-sort-col="${opts.sortCol}"`
        : "";
  const mark = opts.sorted ? ` data-dir="${opts.dir === "asc" ? "▲" : "▼"}"` : "";
  return `<th class="${cls}" ${data}${mark}>${escapeHtml(label)}</th>`;
}

function renderTable(el, rows, sortState, tableKey) {
  if (!rows || rows.length < 2) {
    el.innerHTML = `<p class="empty">표를 불러오지 못했습니다.</p>`;
    return;
  }

  const header = rows[0];
  const width = header.length;
  const teamIdx = header.findIndex((h) => h === "팀명");
  const rankIdx = header.findIndex((h) => h === "순위");
  const body = rows.slice(1).map((raw) => padRow(raw, width));
  const totals = body.filter((r) => r[0] === "합계");
  const dataRows = body.filter((r) => r[0] !== "합계");
  const col = sortState.col ?? 0;
  const sorted = sortRows(dataRows, col, sortState.dir, (row, c) => {
    const raw = row[c];
    const n = Number(String(raw).replace(/,/g, ""));
    return raw !== "" && Number.isFinite(n) ? n : String(raw);
  }).concat(totals);

  const headHtml = header
    .map((cell, i) =>
      th(cell, {
        cls: [i < 2 ? `sticky-${i + 1}` : "", i === teamIdx ? "team" : "", i === rankIdx ? "rank" : ""].filter(Boolean).join(" "),
        sortCol: i,
        sorted: sortState.col === i,
        dir: sortState.dir,
      })
    )
    .join("");

  const bodyHtml = sorted
    .map((row) => {
      const isTotal = row[0] === "합계";
      const tds = row
        .map((cell, i) => {
          const cls = [
            i < 2 ? `sticky-${i + 1}` : "",
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

  el.innerHTML = `<div class="table-wrap"><table class="slim" data-table="${tableKey}"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderSim() {
  const teams = computedTeams();
  if (!teams.length) {
    $("sim-table").innerHTML = `<p class="empty">순위 데이터를 불러오지 못했습니다.</p>`;
    return;
  }

  const sort = state.sorts.sim;
  const sorted = sortRows(teams, sort.key, sort.dir, (t, key) => t[key]);
  const cols = [
    ["순위", "rank", "rank sticky-1"],
    ["팀명", "name", "team sticky-2"],
    ["경기", "g", ""],
    ["승률", "pct", ""],
    ["잔여", "remain", ""],
    ["피타", "pyth", ""],
    ["b_wp", "binomFinalPct", ""],
    ["b_rk", "binomRank", ""],
    ["p_wp", "pythFinalPct", ""],
    ["p_rk", "pythRank", ""],
    ["v_wp", "versusFinalPct", ""],
    ["v_rk", "versusRank", ""],
  ];

  const head = cols
    .map(([label, key, cls]) =>
      th(label, {
        cls,
        sortKey: key,
        sorted: sort.key === key,
        dir: sort.dir,
      })
    )
    .join("");

  const body = sorted
    .map((t) => {
      return `<tr>
        <td class="rank sticky-1">${t.rank}</td>
        <td class="team sticky-2">${teamDot(t.name)}</td>
        <td>${t.g}</td>
        <td>${formatPct(t.pct)}</td>
        <td>${t.remain}</td>
        <td>${formatPct(t.pyth)}</td>
        <td>${formatPct(t.binomFinalPct)}</td>
        <td>${t.binomRank}</td>
        <td>${formatPct(t.pythFinalPct)}</td>
        <td>${t.pythRank}</td>
        <td>${formatPct(t.versusFinalPct)}</td>
        <td>${t.versusRank}</td>
      </tr>`;
    })
    .join("");

  $("sim-table").innerHTML = `<div class="table-wrap"><table class="slim" data-table="sim"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  renderRemainBoards();
  renderLadder();
}

function remainOutcomes(team) {
  const n = team.remain;
  const out = [];
  for (let w = n; w >= 0; w -= 1) {
    const l = n - w;
    const fw = team.w + w;
    const fl = team.l + l;
    out.push({ extraW: w, extraL: l, fw, fl, pct: pct(fw, fl) });
  }
  return out;
}

function raceTeamsByStandings() {
  return [...state.sim]
    .filter((t) => RACE_TEAMS.includes(t.name))
    .sort((a, b) => b.w / Math.max(1, b.w + b.l) - a.w / Math.max(1, a.w + a.l) || b.w - a.w || a.l - b.l);
}

function renderLadder() {
  const teams = raceTeamsByStandings();
  if (teams.length < 4) {
    $("race-ladder").innerHTML = `<p class="empty">KT·삼성·LG·KIA 순위 데이터가 부족합니다.</p>`;
    return;
  }

  const cols = teams.map((t) => ({ team: t, outcomes: remainOutcomes(t) }));
  const allPcts = cols.flatMap((c) => c.outcomes.map((o) => o.pct));
  const maxP = Math.max(...allPcts);
  const minP = Math.min(...allPcts);
  const range = maxP - minP || 0.01;
  const steps = cols.map((c) =>
    c.outcomes.length > 1 ? Math.abs(c.outcomes[0].pct - c.outcomes[1].pct) : 0.01
  );
  const minStep = Math.min(...steps);
  const rowH = 16;
  const pxPerWp = rowH / minStep;
  const height = range * pxPerWp + rowH;

  const ticks = [];
  const tickStep = Math.max(0.01, Math.round((range / 6) * 100) / 100);
  for (let v = Math.ceil(maxP * 100) / 100; v >= minP - 0.0001; v -= tickStep) {
    ticks.push(v);
  }

  const axis = ticks
    .map((v) => {
      const top = (maxP - v) * pxPerWp;
      return `<div class="ladder-tick" style="top:${top}px">${v.toFixed(3)}</div>`;
    })
    .join("");

  const columns = cols
    .map((col) => {
      const cells = col.outcomes
        .map((o) => {
          const top = (maxP - o.pct) * pxPerWp;
          const tint = teamTint(col.team.name);
          const focus = col.team.name === FOCUS_TEAM;
          const bg = focus ? tint.bg : "#fff";
          return `<div class="ladder-cell${focus ? " focus" : ""}" style="top:${top}px;height:${rowH - 2}px;border-left-color:${tint.border};background:${bg}">
            <b class="ladder-wl">${o.extraW}-${o.extraL}</b><span class="ladder-wp"> · ${formatPct(o.pct)}</span>
          </div>`;
        })
        .join("");
      return `<div class="ladder-col" style="height:${height}px">${cells}</div>`;
    })
    .join("");

  $("race-ladder").innerHTML = `<div class="ladder">
    <div class="ladder-head">승률</div>
    ${teams.map((t) => `<div class="ladder-head">${escapeHtml(t.name)} · 잔여 ${t.remain}</div>`).join("")}
    <div class="ladder-axis" style="height:${height}px">${axis}</div>
    ${columns}
  </div>`;
}

function parseH2hRecord(cell) {
  if (!cell || cell === "■") return null;
  const text = String(cell).replace(/\s+/g, "");
  const dashed = text.match(/^(\d+)-(\d+)-(\d+)$/);
  if (dashed) return { w: Number(dashed[1]), l: Number(dashed[2]), t: Number(dashed[3]) };
  const named = text.match(/^(\d+)승(\d+)패(\d+)무$/);
  if (named) return { w: Number(named[1]), l: Number(named[2]), t: Number(named[3]) };
  return null;
}

function remainingOpponents(focus) {
  const rows = state.data?.h2h;
  if (!rows || rows.length < 2) return [];
  const header = rows[0];
  const row = rows.slice(1).find((r) => r[0] === focus);
  if (!row) return [];
  const items = [];
  for (let i = 1; i < header.length; i += 1) {
    const name = String(header[i] || "")
      .replace(/\(.*\)/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (!name || name === "합계" || name === focus) continue;
    const rec = parseH2hRecord(row[i]);
    if (!rec) continue;
    const played = rec.w + rec.l + rec.t;
    const remain = Math.max(0, GAMES_PER_OPPONENT - played);
    const decided = rec.w + rec.l;
    items.push({
      name,
      remain,
      w: rec.w,
      l: rec.l,
      t: rec.t,
      wp: decided === 0 ? 0 : rec.w / decided,
    });
  }
  return items.filter((x) => x.remain > 0);
}

function remainBoard(team) {
  const items = remainingOpponents(team.name);
  const total = items.reduce((sum, x) => sum + x.remain, 0);
  const cols = Math.max(items.length, 1);
  const cells = (row) =>
    (items.length ? items : [null])
      .map((x) => {
        if (!x) return `<div class="remain-cell empty">-</div>`;
        if (row === "head") {
          return `<div class="remain-cell name">${teamDot(x.name)} · ${x.remain}G</div>`;
        }
        return `<div class="remain-cell rec">${x.w}-${x.l}-${x.t} · ${formatPct(x.wp)}</div>`;
      })
      .join("");
  return `<article class="remain-board">
    <h3>${teamDot(team.name)} 잔여 ${total}G · ${items.length}상대</h3>
    <div class="remain-grid" style="--cols:${cols}">
      ${cells("head")}${cells("rec")}
    </div>
  </article>`;
}

function renderRemainBoards() {
  const el = $("remain-boards");
  if (!el) return;
  const teams = raceTeamsByStandings();
  if (!teams.length) {
    el.innerHTML = `<p class="empty">잔여 대진을 계산하지 못했습니다.</p>`;
    return;
  }
  el.innerHTML = `<p class="hint">순위 순. 상대전적 승률 = 승 / (승+패). 잔여 = 16 − (승+패+무).</p>
    ${teams.map(remainBoard).join("")}`;
}

function renderRecords() {
  const data = state.data;
  $("asof").textContent = data.asOfLabel || "";
  renderTable($("rank-table"), data.rank, state.sorts.rank, "rank");
  renderTable($("h2h-table"), data.h2h, state.sorts.h2h, "h2h");
  renderTable($("hitter-table"), data.hitter, state.sorts.hitter, "hitter");
  renderTable($("pitcher-table"), data.pitcher, state.sorts.pitcher, "pitcher");
}

function setStatus(kind, text) {
  const el = $("data-status");
  el.className = kind === "live" ? "status-live" : "status-snap";
  el.textContent = text;
}

function tableRows(table) {
  return [...table.rows].map((tr) =>
    [...tr.cells].flatMap((td) => {
      const span = Number(td.colSpan || 1);
      const text = td.textContent.replace(/\s+/g, " ").trim();
      return Array.from({ length: span }, (_, i) => (i === 0 ? text : ""));
    })
  );
}

function parseAllTables(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found = [...doc.querySelectorAll("table.tData")];
  const tables = found.length ? found : [...doc.querySelectorAll("table")];
  return tables.map(tableRows).filter((rows) => rows.length >= 2);
}

function pickH2h(tables) {
  return (
    (tables || []).find((t) => t[0] && t[0].some((c) => /승-패|승패/.test(String(c)))) ||
    tables[1] ||
    []
  );
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
    h2h: pickH2h(rank.tables),
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
  if ((!data.h2h || data.h2h.length < 2) && state.data?.h2h?.length >= 2) {
    data = { ...data, h2h: state.data.h2h };
  }
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

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function explainAdminError(err, step) {
  const m = String(err.message || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return step === "github"
      ? "GitHub에 연결하지 못했습니다. 광고차단이 api.github.com을 막는지 확인하세요."
      : "KBO 기록실을 가져오지 못했습니다. 잠시 후 다시 눌러보세요.";
  }
  if (/Bad credentials/i.test(m)) return "토큰이 거부됐습니다. 만료됐거나 복사가 잘못된 것입니다. 다시 발급하세요.";
  if (/Resource not accessible/i.test(m)) return "토큰에 Contents Read and write 권한이 없습니다.";
  if (/Not Found/i.test(m)) return "이 토큰으로 레포를 찾지 못했습니다. 저장소를 wmjoo/kbo_rank_sim 으로 선택했는지 확인하세요.";
  return m;
}

async function githubJson(url, token, options = {}) {
  const t = fetchTimeout(15000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: t.signal,
      headers: { ...ghHeaders(token), ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `GitHub ${res.status}`);
    return body;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("GitHub 요청이 시간 초과됐습니다.");
    throw err;
  } finally {
    t.clear();
  }
}

async function verifyToken(token) {
  await githubJson(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/data/kbo.json?ref=${REPO.branch}`,
    token
  );
}

async function putRepoFile(token, path, content, message) {
  const api = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}`;
  let sha;
  try {
    const current = await githubJson(`${api}?ref=${REPO.branch}`, token);
    sha = current.sha;
  } catch {
    sha = undefined;
  }
  const payload = {
    message,
    content: toBase64(content),
    branch: REPO.branch,
  };
  if (sha) payload.sha = sha;
  return githubJson(api, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function adminLog(text) {
  $("admin-log").textContent = text;
}

function formatProb(rate) {
  if (!Number.isFinite(rate)) return "-";
  const text = (rate * 100).toFixed(1);
  return text === "0.0" ? "-" : `${text}%`;
}

function rankProbs(row) {
  if (Array.isArray(row.ranks) && row.ranks.length) return row.ranks;
  return Array.from({ length: 10 }, (_, i) => row[`p${i + 1}`] ?? 0);
}

function metricRankValues(payload, team, rankIdx) {
  return MC_METRICS.map((m) => {
    const row = (payload.results?.[m.key] || []).find((t) => t.name === team);
    if (!row) return NaN;
    return rankProbs(row)[rankIdx];
  }).filter(Number.isFinite);
}

function avgMinMax(values) {
  if (!values.length) return { avg: NaN, min: NaN, max: NaN };
  return {
    avg: values.reduce((sum, v) => sum + v, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function redColorMap(p) {
  const t = Math.max(0, Math.min(1, Number(p) || 0));
  const stops = [
    [0, [255, 249, 247]],
    [0.2, [254, 214, 206]],
    [0.4, [246, 140, 128]],
    [0.65, [214, 52, 48]],
    [1, [128, 14, 20]],
  ];
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i += 1;
  const [t0, c0] = stops[i];
  const [t1, c1] = stops[i + 1];
  const u = (t - t0) / (t1 - t0 || 1);
  const rgb = c0.map((v, k) => Math.round(v + (c1[k] - v) * u));
  const luma = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  return { bg: `rgb(${rgb.join(",")})`, dark: luma < 0.55 };
}

function renderMcCards(payload) {
  const stats = [0, 1, 2, 3].map((idx) => ({
    idx,
    ...avgMinMax(metricRankValues(payload, FOCUS_TEAM, idx)),
  }));
  const peak = Math.max(0, ...stats.map((s) => (Number.isFinite(s.avg) ? s.avg : 0)));
  const cards = stats
    .map((s) => {
      const heat = redColorMap(s.avg);
      const isMax = Number.isFinite(s.avg) && s.avg > 0 && s.avg === peak;
      const ink = heat.dark ? "#fff7f5" : "#3a1f1f";
      const muted = heat.dark ? "rgba(255,247,245,0.78)" : "#8a6a66";
      return `<article class="mc-card${isMax ? " max" : ""}" style="background:${heat.bg};color:${ink};--mc-muted:${muted}">
        <span class="mc-card-k">${s.idx + 1}위</span>
        <b>${formatProb(s.avg)}</b>
        <small>[${formatProb(s.min)}–${formatProb(s.max)}]</small>
      </article>`;
    })
    .join("");
  return `<div class="mc-cards">${cards}</div>
    <p class="mc-cards-note">${escapeHtml(FOCUS_TEAM)} · 이항·피타·상대전적 평균 [최소–최대] · 배경은 0–100% 레드 스케일</p>`;
}

function kstStamp() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dateCompact: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`,
  };
}

function bernoulliWins(n, p) {
  let w = 0;
  for (let i = 0; i < n; i += 1) {
    if (Math.random() < p) w += 1;
  }
  return w;
}

function versusGamePs(team) {
  const fallback = pct(team.w, team.l);
  const items = remainingOpponents(team.name);
  const ps = [];
  let accounted = 0;
  items.forEach((x) => {
    const take = Math.min(x.remain, Math.max(0, team.remain - accounted));
    const p = x.w + x.l === 0 ? fallback : x.wp;
    for (let i = 0; i < take; i += 1) ps.push(p);
    accounted += take;
  });
  const leftover = Math.max(0, team.remain - accounted);
  for (let i = 0; i < leftover; i += 1) ps.push(fallback);
  return { ps, leftover, opponents: items.map((x) => ({ name: x.name, remain: x.remain, p: x.w + x.l === 0 ? fallback : x.wp })) };
}

function winsFromPs(ps) {
  let w = 0;
  ps.forEach((p) => {
    if (Math.random() < p) w += 1;
  });
  return w;
}

function rankSimTeams(rows) {
  return [...rows].sort((a, b) => b.fp - a.fp || b.fw - a.fw || a.fl - b.fl || a.name.localeCompare(b.name, "ko"));
}

function buildMcPlans(teams) {
  return teams.map((t) => {
    const cur = pct(t.w, t.l);
    const versus = versusGamePs(t);
    return {
      name: t.name,
      w: t.w,
      l: t.l,
      t: t.t,
      g: t.g,
      remain: t.remain,
      expected: {
        binom: t.binomFinalPct,
        pyth: t.pythFinalPct,
        versus: t.versusFinalPct,
      },
      p: { binom: cur, pyth: t.pyth, versus: versus.ps.length ? versus.ps.reduce((s, p) => s + p, 0) / versus.ps.length : cur },
      versus,
    };
  });
}

function simulateMetric(plans, metric) {
  const rows = plans.map((t) => {
    const extraW = metric === "versus" ? winsFromPs(t.versus.ps) : bernoulliWins(t.remain, t.p[metric]);
    const fw = t.w + extraW;
    const fl = t.l + (t.remain - extraW);
    return { name: t.name, fw, fl, fp: pct(fw, fl) };
  });
  return rankSimTeams(rows);
}

async function runMonteCarlo(n, onProgress) {
  const teams = computedTeams();
  if (!teams.length) throw new Error("순위 데이터가 없습니다.");
  const plans = buildMcPlans(teams);
  const acc = {};
  plans.forEach((t) => {
    acc[t.name] = {};
    MC_METRICS.forEach((m) => {
      acc[t.name][m.key] = { counts: Array(10).fill(0), rankSum: 0, pctSum: 0 };
    });
  });

  const chunk = 200;
  for (let done = 0; done < n; done += chunk) {
    const take = Math.min(chunk, n - done);
    for (let i = 0; i < take; i += 1) {
      MC_METRICS.forEach((m) => {
        const ranked = simulateMetric(plans, m.key);
        ranked.forEach((row, idx) => {
          const stat = acc[row.name][m.key];
          const rank = idx + 1;
          if (rank >= 1 && rank <= 10) stat.counts[rank - 1] += 1;
          stat.rankSum += rank;
          stat.pctSum += row.fp;
        });
      });
    }
    if (onProgress) onProgress(done + take, n);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const stamp = kstStamp();
  const results = {};
  MC_METRICS.forEach((m) => {
    results[m.key] = plans
      .map((t) => {
        const stat = acc[t.name][m.key];
        const ranks = stat.counts.map((c) => c / n);
        return {
          name: t.name,
          expectedPct: t.expected[m.key],
          priorP: t.p[m.key],
          ranks,
          p1: ranks[0],
          p2: ranks[1],
          p3: ranks[2],
          p4: ranks[3],
          p5: ranks[4],
          p6: ranks[5],
          p7: ranks[6],
          p8: ranks[7],
          p9: ranks[8],
          p10: ranks[9],
          meanRank: stat.rankSum / n,
          meanFinalPct: stat.pctSum / n,
        };
      })
      .sort((a, b) => b.expectedPct - a.expectedPct || b.p1 - a.p1 || a.name.localeCompare(b.name, "ko"));
  });

  return {
    asOf: state.data?.asOf || null,
    asOfLabel: state.data?.asOfLabel || "",
    ranAt: stamp.iso,
    ranDate: stamp.date,
    ranTime: stamp.time,
    n,
    seasonGames: SEASON_GAMES,
    gamesPerOpponent: GAMES_PER_OPPONENT,
    method: "independent_bernoulli",
    note: "잔여 경기는 팀별 독립 베르누이. 맞대결에서 한 팀의 승이 다른 팀의 패가 되는 상관은 넣지 않음.",
    priors: {
      binom: { type: "current_wp", desc: "잔여 각 경기를 현재 승률 p=W/(W+L)로 추출" },
      pyth: { type: "pythagorean", exponent: 2, desc: "잔여 각 경기를 피타고리안 승률로 추출" },
      versus: { type: "h2h_remaining", fallback: "current_wp", desc: "잔여를 상대별로 나눠 상대전적 승률로 추출. 빠진 잔여는 현재 승률" },
    },
    standings: plans.map((t) => ({
      name: t.name,
      g: t.g,
      w: t.w,
      l: t.l,
      t: t.t,
      remain: t.remain,
      p: t.p,
      versus: t.versus.opponents,
    })),
    results,
  };
}

function mcLog(text) {
  const el = $("mc-log");
  if (el) el.textContent = text;
}

function renderMcResults(payload) {
  const el = $("mc-results");
  if (!el) return;
  if (!payload?.results) {
    el.innerHTML = `<p class="empty">시뮬레이션 시작을 누르면 1~10위 확률을 계산합니다.</p>`;
    return;
  }
  const head = `<p class="mc-meta">${escapeHtml(payload.ranDate)} ${escapeHtml(payload.ranTime || "")} · ${payload.n.toLocaleString("ko-KR")}회 · 기준 ${escapeHtml(payload.asOf || "-")} · 독립 베르누이</p>`;
  const rankHeads = Array.from({ length: 10 }, (_, i) => `<th>${i + 1}위</th>`).join("");
  const blocks = MC_METRICS.map((m) => {
    const rows = [...(payload.results[m.key] || [])].sort(
      (a, b) => b.expectedPct - a.expectedPct || a.name.localeCompare(b.name, "ko")
    );
    const body = rows
      .map((r) => {
        const ranks = rankProbs(r);
        const rankCells = ranks
          .map((p, i) => `<td${i === 0 ? ' class="mc-p1"' : ""}>${formatProb(p)}</td>`)
          .join("");
        return `<tr${r.name === FOCUS_TEAM ? ' class="mc-focus"' : ""}>
        <td class="team">${teamDot(r.name)}</td>
        <td>${formatPct(r.expectedPct)}</td>
        ${rankCells}
        <td>${Number(r.meanRank).toFixed(2)}</td>
      </tr>`;
      })
      .join("");
    return `<article class="mc-block">
      <h3>${m.label} · 사전확률 ${m.prior}</h3>
      <div class="table-wrap"><table class="slim">
        <thead><tr><th class="team">팀</th><th>기대</th>${rankHeads}<th>평균순위</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </article>`;
  }).join("");
  el.innerHTML = renderMcCards(payload) + head + blocks;
}

function simResultPath(payload) {
  const asOfKey = String(payload.asOf || payload.ranDate || "").replaceAll("-", "");
  return `data/sim_result_${asOfKey}_${payload.n}.json`;
}

async function saveStandings(token, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  await putRepoFile(token, `data/daily/${data.asOf}.json`, text, `${data.asOf} KBO 기록 수집`);
  await putRepoFile(token, "data/kbo.json", text, `${data.asOf} KBO 최신 스냅샷`);
}

async function saveMcResult(payload, token = getToken()) {
  if (!token) {
    mcLog(`${payload.ranDate} · ${payload.n.toLocaleString("ko-KR")}회 완료. 저장하려면 도움말 탭에 토큰을 넣으세요.`);
    return false;
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await putRepoFile(token, simResultPath(payload), text, `${payload.asOf || payload.ranDate} 몬테카를로 ${payload.n}회`);
  await putRepoFile(token, "data/sim_latest.json", text, `${payload.asOf || payload.ranDate} 몬테카를로 최신`);
  return true;
}

async function persistAll(token) {
  const saved = [];
  if (state.data?.asOf) {
    await saveStandings(token, state.data);
    saved.push("순위표");
  }
  if (state.mc?.results) {
    await saveMcResult(state.mc, token);
    saved.push("시뮬");
  }
  return saved;
}

function pickBestMc(payloads) {
  return payloads
    .filter((p) => p?.results)
    .sort((a, b) => String(b.asOf || "").localeCompare(String(a.asOf || "")) || Number(b.n || 0) - Number(a.n || 0))[0];
}

async function fetchSimPayloads() {
  const found = [];
  const token = getToken();
  try {
    const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/data?ref=${REPO.branch}`;
    const res = await fetch(url, token ? { headers: ghHeaders(token) } : {});
    const files = res.ok ? await res.json() : [];
    if (Array.isArray(files)) {
      const sims = files.filter((f) => f.name === "sim_latest.json" || /^sim_result_/.test(f.name));
      for (const file of sims) {
        try {
          const src = file.download_url || `data/${file.name}`;
          const body = await fetch(src, { cache: "no-store" });
          if (body.ok) found.push(await body.json());
        } catch {
          /* skip one file */
        }
      }
    }
  } catch {
    /* fall through */
  }
  if (!found.length) {
    try {
      const res = await fetch("data/sim_latest.json", { cache: "no-store" });
      if (res.ok) found.push(await res.json());
    } catch {
      /* none */
    }
  }
  return found;
}

async function loadLatestMc() {
  try {
    const best = pickBestMc(await fetchSimPayloads());
    if (!best) {
      renderMcResults(null);
      return;
    }
    state.mc = best;
    renderMcResults(best);
    mcLog(`저장된 결과 · 기준 ${best.asOf || "-"} · ${Number(best.n).toLocaleString("ko-KR")}회`);
  } catch {
    renderMcResults(null);
  }
}

async function startMonteCarlo() {
  const n = Number($("mc-n").value) || 10000;
  const btn = $("mc-run");
  btn.disabled = true;
  try {
    mcLog(`시뮬레이션 ${n.toLocaleString("ko-KR")}회 실행 중…`);
    const payload = await runMonteCarlo(n, (done, total) => {
      mcLog(`시뮬레이션 ${done.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}`);
    });
    state.mc = payload;
    renderMcResults(payload);
    try {
      const ok = await saveMcResult(payload);
      if (ok) mcLog(`${payload.asOf || payload.ranDate} · ${payload.n.toLocaleString("ko-KR")}회 저장 완료.`);
    } catch (err) {
      mcLog(`화면 결과는 있습니다. 저장 실패: ${explainAdminError(err, "github")}`);
    }
  } catch (err) {
    mcLog(`실행 실패: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function collectAndSave() {
  const token = getToken();
  if (!token) {
    adminLog("Contents 쓰기 권한 토큰을 입력한 뒤 저장하세요.");
    return;
  }
  const btn = $("collect-save");
  btn.disabled = true;
  try {
    adminLog("토큰 확인 중…");
    await verifyToken(token);
    adminLog("KBO 기록실에서 수집하는 중…");
    let data;
    let live = true;
    try {
      data = await importLive();
    } catch (err) {
      if (!state.data?.rank) throw err;
      data = state.data;
      live = false;
      adminLog(`라이브 수집 실패(${explainAdminError(err, "kbo")}). 현재 스냅샷으로 저장합니다…`);
    }
    if (!data.asOf) throw new Error("기준 일자를 읽지 못했습니다.");
    adminLog(`${data.asOfLabel || data.asOf} 표를 레포에 저장하는 중…`);
    await saveStandings(token, data);
    applyData(data, live ? "live" : "snapshot");
    if (state.mc?.results) await saveMcResult(state.mc, token);
    adminLog(`${data.asOf} 순위표${state.mc?.results ? "·시뮬" : ""} 저장 완료${live ? "" : " (스냅샷)"}.`);
    await loadDailyList();
  } catch (err) {
    adminLog(`저장 실패: ${explainAdminError(err, "github")}`);
  } finally {
    btn.disabled = false;
  }
}

async function loadDailyList() {
  const box = $("daily-list");
  const token = getToken();
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/data/daily?ref=${REPO.branch}`;
  try {
    const res = await fetch(url, token ? { headers: ghHeaders(token) } : {});
    if (res.status === 404) {
      box.innerHTML = `<p class="empty">아직 레포에 저장된 일자가 없습니다. 위에서 한 번 수집하면 생깁니다.</p>`;
      return;
    }
    const files = await res.json();
    if (!Array.isArray(files)) throw new Error(files.message || "목록을 읽지 못했습니다.");
    const dates = files
      .filter((f) => f.name.endsWith(".json"))
      .map((f) => f.name.replace(".json", ""))
      .sort()
      .reverse();
    if (!dates.length) {
      box.innerHTML = `<p class="empty">아직 저장된 일자가 없습니다.</p>`;
      return;
    }
    box.innerHTML = `<div class="daily-list">${dates
      .map((d) => `<a href="https://github.com/${REPO.owner}/${REPO.name}/blob/${REPO.branch}/data/daily/${d}.json" target="_blank" rel="noreferrer">${d}</a>`)
      .join("")}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderAll() {
  if (!state.data) return;
  renderSim();
  renderRecords();
}

function renderHelpMath() {
  if (!window.katex) return;
  document.querySelectorAll(".formula[data-tex]").forEach((el) => {
    if (el.dataset.rendered === "1") return;
    window.katex.render(el.dataset.tex, el, { displayMode: true, throwOnError: false });
    el.dataset.rendered = "1";
  });
}

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  const hash = name === "sim" ? "#sim" : `#${name}`;
  history.replaceState(null, "", hash);
  if (name === "admin") {
    renderHelpMath();
    loadDailyList();
  }
}

function bindSortClicks() {
  document.body.addEventListener("click", (e) => {
    const thEl = e.target.closest("th.sortable");
    if (!thEl) return;
    const table = thEl.closest("table");
    if (!table) return;
    const name = table.dataset.table;
    const store = state.sorts[name];
    if (!store) return;
    if (thEl.dataset.sortKey) {
      const key = thEl.dataset.sortKey;
      const numericDesc = !["rank", "name", "binomRank", "pythRank", "versusRank"].includes(key);
      toggleSort(store, key, numericDesc ? "desc" : "asc");
    } else if (thEl.dataset.sortCol != null) {
      const col = Number(thEl.dataset.sortCol);
      toggleSort(store, col, col === 0 ? "asc" : "desc");
    }
    renderAll();
  });
}

function bind() {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      setTab(btn.dataset.tab);
    });
  });
  bindSortClicks();

  const saved = localStorage.getItem(TOKEN_KEY) || "";
  if (saved) $("gh-token").value = saved;

  $("save-token").addEventListener("click", async () => {
    const token = $("gh-token").value.replace(/\s+/g, "");
    $("gh-token").value = token;
    if (!token) {
      adminLog("토큰이 비어 있습니다.");
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    adminLog("토큰을 저장했습니다. GitHub 권한을 확인하는 중…");
    try {
      await verifyToken(token);
      adminLog("토큰 확인됨. 현재 순위표·시뮬 결과를 저장하는 중…");
      const saved = await persistAll(token);
      adminLog(
        saved.length
          ? `토큰 확인됨. ${saved.join("·")} 저장 완료.`
          : "토큰 확인됨. 아직 저장할 순위표/시뮬 결과가 없습니다."
      );
    } catch (err) {
      adminLog(`토큰은 저장됐지만 확인/저장 실패: ${explainAdminError(err, "github")}`);
    }
  });
  $("clear-token").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    $("gh-token").value = "";
    adminLog("토큰을 지웠습니다.");
  });
  $("collect-save").addEventListener("click", collectAndSave);

  $("mc-run")?.addEventListener("click", (e) => {
    e.preventDefault();
    startMonteCarlo();
  });

  const tab = location.hash.replace("#", "");
  setTab(["sim", "scenario", "records", "admin"].includes(tab) ? tab : "sim");
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
  await loadLatestMc();
  renderHelpMath();
  setTimeout(renderHelpMath, 0);
  setTimeout(renderHelpMath, 400);
}

bind();
boot();
