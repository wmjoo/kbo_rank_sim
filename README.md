# KBO 순위 시뮬레이터

KBO 공식 기록실 표를 가져와 잔여 시즌을 추정하는 모바일용 페이지입니다.

- 페이지: https://wmjoo.github.io/kbo_rank_sim/
- 저장소: https://github.com/wmjoo/kbo_rank_sim

## 탭

- **시뮬레이터**: 이항(현재 승률) · 피타고리안 · 상대전적 세 사전확률로 잔여 경기를 몬테카를로 추출합니다. 기본 10,000회. 팀별 1~10위 확률과 LG 1~4위 평균[최소–최대] 카드를 보여 줍니다.
- **시나리오**: 점추정 최종승률(`b_wp` / `p_wp` / `v_wp`)과 KT·삼성·LG·KIA 승률 사다리, 잔여 대진 표.
- **기록실**: 팀 순위, 팀간 승패표, 팀 타격, 팀 투수 원본 표. 헤더를 누르면 정렬됩니다.
- **도움말**: 산출 수식, GitHub 토큰, 일자별 수집.

## 기준일자 (`라이브 · YYYY년 M월 D일 기준`)

오늘 날짜가 아닙니다. [KBO 일자별 팀 순위](https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx) HTML에서 `YYYY년 M월 D일`을 읽습니다. 그날까지 반영된 공식 순위표의 날짜입니다.

페이지를 열면 `data/kbo_standings/index.json`의 `latest` 날짜 파일을 먼저 보여 주고, 라이브 수집이 되면 `라이브 · …`로 바꿉니다.

## 데이터 폴더

중복 스냅샷(`kbo.json`)은 두지 않습니다. 날짜별 파일만 쌓고, 최신은 각 폴더의 `index.json`이 가리킵니다.

```
data/
  kbo_standings/                 # KBO 공식 기록 (순위·상대전적·타격·투수)
    index.json                   # { latest, files: ["YYYY-MM-DD", ...] }
    2026-09-20.json
  montecarlo/                    # 몬테카를로 결과
    index.json                   # { files: [{ asOf, n, path }] }
    2026-09-20_n50000.json       # 기준일_n반복횟수
```

## 저장

GitHub Pages는 정적 사이트라 브라우저에서 레포에 쓰려면 **Contents Read and write** Personal Access Token이 필요합니다. 토큰은 이 브라우저 `localStorage`에만 남습니다.

- **토큰 저장**: 키 확인 후, 지금 화면의 순위표와 시뮬 결과를 레포에 올립니다.
- **지금 수집해서 저장**: `data/kbo_standings/YYYY-MM-DD.json`과 인덱스를 갱신합니다.
- **시뮬레이션 시작**: `data/montecarlo/YYYY-MM-DD_n횟수.json`과 인덱스를 갱신합니다.

시뮬레이터 탭은 인덱스의 **최신 기준일 · 최다 횟수** 파일을 바로 보여 줍니다.

## 로컬

```bash
python3 scripts/fetch_kbo.py
python3 -m http.server 8765
```

브라우저에서 http://127.0.0.1:8765/ 를 엽니다.
