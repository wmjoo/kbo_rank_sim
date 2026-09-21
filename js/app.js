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
const FOCUS_TEAM = "LG";
const RACE_TEAMS = ["삼성", "LG", "KIA"];
const REPO = { owner: "wmjoo", name: "kbo_rank_sim", branch: "main" };
const TOKEN_KEY = "kbo.githubToken";

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
  sorts: {
    sim: { key: "rank", dir: "asc" },
    rank: { col: 0, dir: "asc" },
    hitter: { col: 0, dir: "asc" },
    pitcher: { col: 0, dir: "asc" },
    lgCombo: { key: "extraW", dir: "desc" },
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

function computedTeams() {
  const teams = state.sim.map((t) => {
    const curPct = pct(t.w, t.l);
    const denom = t.w + t.l + t.remain;
    const likelyW = binomModeWins(t.remain, curPct);
    const binomFinalPct = pct(t.w + likelyW, t.l + (t.remain - likelyW));
    const pythFinalPct = denom === 0 ? t.pyth : (t.w + t.remain * t.pyth) / denom;
    return { ...t, pct: curPct, likelyW, binomFinalPct, pythFinalPct };
  });
  const binomRank = rankBy(teams, "binomFinalPct");
  const pythRank = rankBy(teams, "pythFinalPct");
  const standings = [...teams].sort((a, b) => b.pct - a.pct || b.w - a.w || a.l - b.l);
  return teams.map((t) => ({
    ...t,
    rank: standings.findIndex((x) => x.name === t.name) + 1,
    binomRank: binomRank[t.name],
    pythRank: pythRank[t.name],
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
    ["피타고리안", "pyth", ""],
    ["이항 최종승률", "binomFinalPct", ""],
    ["이항 최종순위", "binomRank", ""],
    ["피타 최종승률", "pythFinalPct", ""],
    ["피타 최종순위", "pythRank", ""],
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
      const cut = t.rank === 5 ? "cut" : "";
      return `<tr class="${cut}">
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
      </tr>`;
    })
    .join("");

  $("sim-table").innerHTML = `<div class="table-wrap"><table class="slim" data-table="sim"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  renderLgCombo();
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

function renderLgCombo() {
  const team = state.sim.find((t) => t.name === FOCUS_TEAM);
  const title = $("lg-combo-title");
  if (!team) {
    $("lg-combo-table").innerHTML = `<p class="empty">LG 데이터를 찾지 못했습니다.</p>`;
    return;
  }
  title.textContent = `LG Twins 잔여 ${team.remain}경기 승패 조합`;
  const sort = state.sorts.lgCombo;
  const rows = sortRows(remainOutcomes(team), sort.key, sort.dir, (r, key) => r[key]);
  const cols = [
    ["잔여", "extraW"],
    ["최종승", "fw"],
    ["최종패", "fl"],
    ["최종승률", "pct"],
  ];
  const head = cols
    .map(([label, key]) => th(label, { sortKey: key, sorted: sort.key === key, dir: sort.dir }))
    .join("");
  const body = rows
    .map(
      (r) => `<tr>
        <td>${r.extraW}-${r.extraL}</td>
        <td>${r.fw}</td>
        <td>${r.fl}</td>
        <td>${formatPct(r.pct)}</td>
      </tr>`
    )
    .join("");
  $("lg-combo-table").innerHTML = `<div class="table-wrap"><table class="slim" data-table="lgCombo"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderLadder() {
  const teams = RACE_TEAMS.map((name) => state.sim.find((t) => t.name === name)).filter(Boolean);
  if (teams.length < 3) {
    $("race-ladder").innerHTML = `<p class="empty">삼성·LG·KIA 순위 데이터가 부족합니다.</p>`;
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
  const pxPerWp = 26 / minStep;
  const height = range * pxPerWp + 26;

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
          const focus = col.team.name === FOCUS_TEAM ? "focus" : "";
          return `<div class="ladder-cell ${focus}" style="top:${top}px;height:${Math.max(22, minStep * pxPerWp - 2)}px">
            <b>${o.extraW}-${o.extraL}</b>${formatPct(o.pct)}
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

function renderRecords() {
  const data = state.data;
  $("asof").textContent = data.asOfLabel || "";
  renderTable($("rank-table"), data.rank, state.sorts.rank, "rank");
  renderTable($("hitter-table"), data.hitter, state.sorts.hitter, "hitter");
  renderTable($("pitcher-table"), data.pitcher, state.sorts.pitcher, "pitcher");
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

async function githubJson(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...ghHeaders(token), ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `GitHub ${res.status}`);
  return body;
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

function getToken() {
  return ($("gh-token").value || localStorage.getItem(TOKEN_KEY) || "").trim();
}

async function collectAndSave() {
  const token = getToken();
  if (!token) {
    adminLog("repo 권한 토큰을 입력한 뒤 저장하세요.");
    return;
  }
  const btn = $("collect-save");
  btn.disabled = true;
  adminLog("KBO 기록실에서 수집하는 중…");
  try {
    const data = await importLive();
    if (!data.asOf) throw new Error("기준 일자를 읽지 못했습니다.");
    const text = `${JSON.stringify(data, null, 2)}\n`;
    adminLog(`${data.asOfLabel} 표를 레포에 저장하는 중…`);
    await putRepoFile(token, `data/daily/${data.asOf}.json`, text, `${data.asOf} KBO 기록 수집`);
    await putRepoFile(token, "data/kbo.json", text, `${data.asOf} KBO 최신 스냅샷`);
    applyData(data, "live");
    adminLog(`${data.asOf} 저장 완료. Pages가 다시 빌드되면 스냅샷이 갱신됩니다.`);
    await loadDailyList();
  } catch (err) {
    adminLog(`저장 실패: ${err.message}`);
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

function setTab(name) {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  const hash = name === "sim" ? "#sim" : `#${name}`;
  history.replaceState(null, "", hash);
  if (name === "admin") loadDailyList();
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
      const numericDesc = !["rank", "name", "binomRank", "pythRank"].includes(key);
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
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  bindSortClicks();

  const saved = localStorage.getItem(TOKEN_KEY) || "";
  if (saved) $("gh-token").value = saved;

  $("save-token").addEventListener("click", () => {
    const token = $("gh-token").value.trim();
    if (!token) {
      adminLog("토큰이 비어 있습니다.");
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    adminLog("이 브라우저에 토큰을 저장했습니다.");
  });
  $("clear-token").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    $("gh-token").value = "";
    adminLog("토큰을 지웠습니다.");
  });
  $("collect-save").addEventListener("click", collectAndSave);

  const tab = location.hash.replace("#", "");
  setTab(["records", "admin", "sim"].includes(tab) ? tab : "sim");
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

bind();
boot();
