#!/usr/bin/env python3
"""KBO 공식 기록실 표를 가져와 data/kbo.json 과 data/daily/YYYY-MM-DD.json 으로 저장한다."""

from __future__ import annotations

import json
import re
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

SOURCES = {
    "rank": "https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx",
    "hitter": "https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx",
    "pitcher": "https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx",
}


class TableFinder(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_table = False
        self.depth = 0
        self.tables: list[list[list[str]]] = []
        self.cur: list[list[str]] | None = None
        self.cur_row: list[str] | None = None
        self.cur_cell: str | None = None
        self.colspan = 1
        self.capture = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        d = dict(attrs)
        if tag == "table":
            if not self.in_table:
                self.in_table = True
                self.depth = 1
                self.cur = []
            else:
                self.depth += 1
        elif self.in_table and tag == "tr":
            self.cur_row = []
        elif self.in_table and tag in ("td", "th"):
            self.cur_cell = ""
            self.colspan = int(d.get("colspan") or 1)
            self.capture = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "table" and self.in_table:
            self.depth -= 1
            if self.depth == 0:
                self.in_table = False
                if self.cur:
                    self.tables.append(self.cur)
                self.cur = None
        elif self.in_table and tag == "tr" and self.cur_row is not None:
            cells = [re.sub(r"\s+", " ", c).strip() for c in self.cur_row]
            if any(cells) and self.cur is not None:
                self.cur.append(cells)
            self.cur_row = None
        elif self.in_table and tag in ("td", "th") and self.cur_cell is not None and self.cur_row is not None:
            self.cur_row.append(self.cur_cell)
            for _ in range(self.colspan - 1):
                self.cur_row.append("")
            self.cur_cell = None
            self.capture = False

    def handle_data(self, data: str) -> None:
        if self.capture and self.cur_cell is not None:
            self.cur_cell += data


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8", errors="replace")


def tables(html: str) -> list[list[list[str]]]:
    parser = TableFinder()
    parser.feed(html)
    if not parser.tables:
        raise RuntimeError("표를 찾지 못했습니다.")
    return parser.tables


def first_table(html: str) -> list[list[str]]:
    return tables(html)[0]


def collect() -> dict:
    rank_html = fetch(SOURCES["rank"])
    hitter_html = fetch(SOURCES["hitter"])
    pitcher_html = fetch(SOURCES["pitcher"])

    asof = re.findall(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", rank_html)
    as_of = f"{asof[0][0]}-{int(asof[0][1]):02d}-{int(asof[0][2]):02d}" if asof else None
    as_of_label = (
        f"{asof[0][0]}년 {int(asof[0][1])}월 {int(asof[0][2])}일 기준" if asof else ""
    )

    rank_tables = tables(rank_html)
    return {
        "asOf": as_of,
        "asOfLabel": as_of_label,
        "sources": SOURCES,
        "rank": rank_tables[0],
        "h2h": rank_tables[1] if len(rank_tables) > 1 else [],
        "hitter": first_table(hitter_html),
        "pitcher": first_table(pitcher_html),
    }


def save(payload: dict) -> list[Path]:
    root = Path(__file__).resolve().parents[1] / "data"
    root.mkdir(parents=True, exist_ok=True)
    daily_dir = root / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)

    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    latest = root / "kbo.json"
    latest.write_text(text, encoding="utf-8")
    saved = [latest]

    if payload.get("asOf"):
        daily = daily_dir / f"{payload['asOf']}.json"
        daily.write_text(text, encoding="utf-8")
        saved.append(daily)
    return saved


def main() -> None:
    payload = collect()
    for path in save(payload):
        print(f"saved {path}")


if __name__ == "__main__":
    main()
