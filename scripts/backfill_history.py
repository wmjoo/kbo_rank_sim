#!/usr/bin/env python3
"""2026-09-01~09-27 KBO 일자별 순위와 5만 회 몬테카를로를 채운다.

순위·상대전적은 공식 일자별 순위 페이지. 득점·실점은 2026-09-27 공식 누적에서
그 이후 정규시즌 경기 득점을 뺀 값이다.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_kbo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
STANDINGS = ROOT / "data" / "kbo_standings"
MONTE = ROOT / "data" / "montecarlo"
RANK_URL = "https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx"
SCHED_PAGE = "https://www.koreabaseball.com/Schedule/Schedule.aspx"
SCHED_API = "https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList"
UA = fetch_kbo.UA
ANCHOR = "2026-09-27"
N = 50000
SEASON_GAMES = 144
GAMES_PER_OPPONENT = 16
START = date(2026, 9, 1)
END = date(2026, 9, 27)


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8", errors="replace")


def hidden(html: str, name: str) -> str:
    match = re.search(rf'name="{re.escape(name)}"[^>]*value="([^"]*)"', html)
    return match.group(1) if match else ""


def fetch_rank_html(day: date, viewstate_html: str) -> tuple[str, str]:
    compact = day.strftime("%Y%m%d")
    target = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect"
    fields = {
        "__EVENTTARGET": target,
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        "__VIEWSTATE": hidden(viewstate_html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden(viewstate_html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden(viewstate_html, "__EVENTVALIDATION"),
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$txtCanlendar": compact,
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlSeries": "0",
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchYear": "2026",
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate": compact,
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfPrevDate": "",
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfNextDate": "",
        "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchSeries": "0",
    }
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(
        RANK_URL,
        data=body,
        headers={
            "User-Agent": UA,
            "Accept-Language": "ko",
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": RANK_URL,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        html = res.read().decode("utf-8", errors="replace")
    return html, html


def page_as_of(html: str) -> str | None:
    found = re.findall(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", html)
    if not found:
        return None
    year, month, day = found[0]
    return f"{year}-{int(month):02d}-{int(day):02d}"


def fetch_games() -> list[tuple[str, str, int, str, int]]:
    http_get(SCHED_PAGE)
    payload = {"leId": "1", "srIdList": "0,9,6", "seasonId": "2026", "gameMonth": "09", "teamId": ""}
    req = urllib.request.Request(
        SCHED_API,
        data=urllib.parse.urlencode(payload).encode(),
        headers={
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": SCHED_PAGE,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        rows = json.loads(res.read().decode("utf-8"))["rows"]

    def strip(text: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()

    games = []
    current = None
    for row in rows:
        cells = row["row"]
        day = next((strip(cell["Text"]) for cell in cells if cell.get("Class") == "day"), None)
        if day:
            match = re.match(r"(\d{2})\.(\d{2})", day)
            current = f"2026-{match.group(1)}-{match.group(2)}" if match else current
        play = next((strip(cell["Text"]) for cell in cells if cell.get("Class") == "play"), "")
        scored = re.match(r"([A-Z가-힣]+)\s+(\d+)\s+vs\s+(\d+)\s+([A-Z가-힣]+)", play)
        if not scored or not current:
            continue
        games.append((current, scored.group(1), int(scored.group(2)), scored.group(4), int(scored.group(3))))
    return games


def runs_between(games, start_exclusive: str, end_inclusive: str) -> tuple[dict[str, int], dict[str, int]]:
    scored: dict[str, int] = {}
    allowed: dict[str, int] = {}
    for game_date, left, left_runs, right, right_runs in games:
        if not (start_exclusive < game_date <= end_inclusive):
            continue
        scored[left] = scored.get(left, 0) + left_runs
        scored[right] = scored.get(right, 0) + right_runs
        allowed[left] = allowed.get(left, 0) + right_runs
        allowed[right] = allowed.get(right, 0) + left_runs
    return scored, allowed


def column_map(rows: list[list[str]], stat: str) -> dict[str, int]:
    header = rows[0]
    team_idx = header.index("팀명")
    stat_idx = header.index(stat)
    out = {}
    for row in rows[1:]:
        name = row[team_idx]
        if name and name != "합계":
            out[name] = int(row[stat_idx])
    return out


def runs_table(order: list[str], values: dict[str, int]) -> list[list[str]]:
    rows = [["팀명", "R"]]
    for name in order:
        rows.append([name, str(values[name])])
    return rows


def parse_h2h(cell: str) -> tuple[int, int, int] | None:
    text = re.sub(r"\s+", "", cell or "")
    match = re.match(r"^(\d+)-(\d+)-(\d+)$", text) or re.match(r"^(\d+)승(\d+)패(\d+)무$", text)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def pct(wins: float, losses: float) -> float:
    total = wins + losses
    return wins / total if total else 0.0


def versus_ps(team: dict, h2h: list[list[str]]) -> list[float]:
    header = h2h[0]
    row = next(item for item in h2h[1:] if item[0] == team["name"])
    fallback = pct(team["w"], team["l"])
    ps: list[float] = []
    accounted = 0
    for idx in range(1, len(header)):
        name = re.sub(r"\(.*\)", "", header[idx] or "")
        name = re.sub(r"\s+", "", name)
        if not name or name in ("합계", team["name"]):
            continue
        rec = parse_h2h(row[idx] if idx < len(row) else "")
        if not rec:
            continue
        wins, losses, ties = rec
        remain = max(0, GAMES_PER_OPPONENT - (wins + losses + ties))
        if remain <= 0:
            continue
        take = min(remain, max(0, team["remain"] - accounted))
        probability = fallback if wins + losses == 0 else wins / (wins + losses)
        ps.extend([probability] * take)
        accounted += take
    leftover = max(0, team["remain"] - accounted)
    ps.extend([fallback] * leftover)
    return ps


def simulate(teams: list[dict], h2h: list[list[str]], seed: int) -> dict:
    rng = np.random.default_rng(seed)
    plans = []
    for team in teams:
        current = pct(team["w"], team["l"])
        ps = versus_ps(team, h2h)
        pyth = team["pyth"]
        denom = team["w"] + team["l"] + team["remain"]
        likely = 0 if team["remain"] <= 0 else min(team["remain"], max(0, round(team["remain"] * current)))
        versus_exp = sum(ps)
        plans.append(
            {
                **team,
                "ps": ps,
                "p": {
                    "binom": current,
                    "pyth": pyth,
                    "versus": float(np.mean(ps)) if ps else current,
                },
                "expected": {
                    "binom": pct(team["w"] + likely, team["l"] + (team["remain"] - likely)),
                    "pyth": pyth if denom == 0 else (team["w"] + team["remain"] * pyth) / denom,
                    "versus": current if denom == 0 else (team["w"] + versus_exp) / denom,
                },
            }
        )

    names = [team["name"] for team in plans]
    name_rank = {name: idx for idx, name in enumerate(sorted(names))}
    results = {}
    for metric in ("binom", "pyth", "versus"):
        wins = np.zeros((N, len(plans)), dtype=np.int16)
        for idx, team in enumerate(plans):
            if team["remain"] <= 0:
                continue
            if metric == "versus":
                probs = np.array(team["ps"], dtype=float)
                wins[:, idx] = (rng.random((N, len(probs))) < probs).sum(axis=1)
            else:
                wins[:, idx] = rng.binomial(team["remain"], team["p"][metric], size=N)
        base_w = np.array([team["w"] for team in plans])
        base_l = np.array([team["l"] for team in plans])
        final_w = base_w + wins
        final_l = base_l + (np.array([team["remain"] for team in plans]) - wins)
        final_pct = np.divide(final_w, final_w + final_l, out=np.zeros_like(final_w, dtype=float), where=(final_w + final_l) > 0)
        tie = np.array([name_rank[name] for name in names], dtype=float)
        score = final_pct * 1_000_000 + final_w * 1_000 - final_l - tie / 100
        order = np.argsort(-score, axis=1)
        counts = np.zeros((len(plans), 10), dtype=np.int32)
        rank_sum = np.zeros(len(plans), dtype=np.float64)
        pct_sum = np.zeros(len(plans), dtype=np.float64)
        for rank in range(len(plans)):
            team_idx = order[:, rank]
            np.add.at(counts, (team_idx, np.full(N, rank)), 1)
            np.add.at(rank_sum, team_idx, rank + 1)
        for team_idx in range(len(plans)):
            pct_sum[team_idx] = final_pct[:, team_idx].sum()
        rows = []
        for idx, team in enumerate(plans):
            ranks = (counts[idx] / N).tolist()
            rows.append(
                {
                    "name": team["name"],
                    "expectedPct": team["expected"][metric],
                    "priorP": team["p"][metric],
                    "ranks": ranks,
                    "p1": ranks[0],
                    "p2": ranks[1],
                    "p3": ranks[2],
                    "p4": ranks[3],
                    "p5": ranks[4],
                    "p6": ranks[5],
                    "p7": ranks[6],
                    "p8": ranks[7],
                    "p9": ranks[8],
                    "p10": ranks[9],
                    "meanRank": float(rank_sum[idx] / N),
                    "meanFinalPct": float(pct_sum[idx] / N),
                }
            )
        rows.sort(key=lambda row: (-row["expectedPct"], -row["p1"], row["name"]))
        results[metric] = rows
    return {"plans": plans, "results": results}


def write_indexes() -> None:
    dates = sorted(path.stem for path in STANDINGS.glob("20*.json"))
    latest = dates[-1]
    (STANDINGS / "index.json").write_text(
        json.dumps({"latest": latest, "files": dates}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    files = []
    for path in sorted(MONTE.glob("20*.json")):
        match = re.match(r"(\d{4}-\d{2}-\d{2})_n(\d+)$", path.stem)
        if not match:
            continue
        files.append(
            {
                "asOf": match.group(1),
                "n": int(match.group(2)),
                "path": f"data/montecarlo/{path.name}",
            }
        )
    files.sort(key=lambda item: (item["asOf"], item["n"]))
    (MONTE / "index.json").write_text(json.dumps({"files": files}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    anchor = json.loads((STANDINGS / f"{ANCHOR}.json").read_text(encoding="utf-8"))
    base_rs = column_map(anchor["hitter"], "R")
    base_ra = column_map(anchor["pitcher"], "R")
    games = fetch_games()
    print(f"games {len(games)}")

    viewstate = http_get(RANK_URL)
    day = START
    while day <= END:
        as_of = day.isoformat()
        standings_path = STANDINGS / f"{as_of}.json"
        sim_path = MONTE / f"{as_of}_n{N}.json"
        if standings_path.exists() and sim_path.exists():
            print(f"keep {as_of}")
            day += timedelta(days=1)
            continue
        if not standings_path.exists():
            html, viewstate = fetch_rank_html(day, viewstate)
            got = page_as_of(html)
            if got != as_of:
                print(f"skip {as_of} page={got}")
                viewstate = http_get(RANK_URL)
                day += timedelta(days=1)
                continue
            tables = fetch_kbo.tables(html)
            rank = tables[0]
            h2h = tables[1] if len(tables) > 1 else []
            order = [row[1] for row in rank[1:] if row[1] and row[1] != "합계"]
            scored, allowed = runs_between(games, as_of, ANCHOR)
            rs = {name: base_rs[name] - scored.get(name, 0) for name in order}
            ra = {name: base_ra[name] - allowed.get(name, 0) for name in order}
            if any(value < 0 for value in list(rs.values()) + list(ra.values())):
                raise RuntimeError(f"negative runs on {as_of}")
            payload = {
                "asOf": as_of,
                "asOfLabel": f"{day.year}년 {day.month}월 {day.day}일 기준",
                "sources": {
                    "rank": RANK_URL,
                    "schedule": SCHED_PAGE,
                    "runsAnchor": ANCHOR,
                },
                "runsNote": "득점·실점은 2026-09-27 공식 팀 득점·실점에서 그 다음 날부터 27일까지의 경기 득점을 뺀 값이다.",
                "rank": rank,
                "h2h": h2h,
                "hitter": runs_table(order, rs),
                "pitcher": runs_table(order, ra),
            }
            standings_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"standings {as_of} g={rank[1][2]}")
        else:
            payload = json.loads(standings_path.read_text(encoding="utf-8"))
            print(f"standings exists {as_of}")

        if not sim_path.exists():
            rank = payload["rank"]
            rs = column_map(payload["hitter"], "R")
            ra = column_map(payload["pitcher"], "R")
            teams = []
            for row in rank[1:]:
                name = row[1]
                if not name or name == "합계":
                    continue
                games_played = int(row[2])
                runs_for = rs[name]
                runs_against = ra[name]
                pyth_den = runs_for**2 + runs_against**2
                teams.append(
                    {
                        "name": name,
                        "g": games_played,
                        "w": int(row[3]),
                        "l": int(row[4]),
                        "t": int(row[5]),
                        "remain": max(0, SEASON_GAMES - games_played),
                        "pyth": 0 if pyth_den == 0 else runs_for**2 / pyth_den,
                    }
                )
            sim = simulate(teams, payload["h2h"], seed=int(day.strftime("%Y%m%d")))
            out = {
                "asOf": payload["asOf"],
                "asOfLabel": payload["asOfLabel"],
                "ranAt": "2026-09-28T14:09:00+09:00",
                "ranDate": "2026-09-28",
                "ranTime": "14:09:00",
                "n": N,
                "seasonGames": SEASON_GAMES,
                "gamesPerOpponent": GAMES_PER_OPPONENT,
                "method": "independent_bernoulli",
                "note": "잔여 경기는 팀별 독립 베르누이. 맞대결에서 한 팀의 승이 다른 팀의 패가 되는 상관은 넣지 않음. 과거 일자는 공식 순위·상대전적과, 9월 27일 누적에서 되돌린 득점·실점을 사용.",
                "priors": {
                    "binom": {"type": "current_wp", "desc": "잔여 각 경기를 현재 승률 p=W/(W+L)로 추출"},
                    "pyth": {"type": "pythagorean", "exponent": 2, "desc": "잔여 각 경기를 피타고리안 승률로 추출"},
                    "versus": {"type": "h2h_remaining", "fallback": "current_wp", "desc": "잔여를 상대별로 나눠 상대전적 승률로 추출. 빠진 잔여는 현재 승률"},
                },
                "standings": [
                    {
                        "name": team["name"],
                        "g": team["g"],
                        "w": team["w"],
                        "l": team["l"],
                        "t": team["t"],
                        "remain": team["remain"],
                        "p": team["p"],
                    }
                    for team in sim["plans"]
                ],
                "results": sim["results"],
            }
            sim_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"sim {as_of}")
        day += timedelta(days=1)

    write_indexes()
    print("indexes updated")


if __name__ == "__main__":
    main()
