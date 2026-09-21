# KBO 순위 시뮬레이터

KBO 공식 기록실 표를 가져와 잔여 시즌을 추정하는 모바일용 페이지입니다.

- 페이지: https://wmjoo.github.io/kbo_rank_sim/
- 저장소: https://github.com/wmjoo/kbo_rank_sim

## 탭

- **시뮬레이터**: 이항(현재 승률) · 피타고리안 · 상대전적 세 사전확률로 잔여 경기를 몬테카를로 추출합니다. 기본 10,000회. 팀별 1~10위 확률과 LG 1~4위 평균[최소–최대] 카드를 보여 줍니다.
- **시나리오**: 점추정 최종승률(`b_wp` / `p_wp` / `v_wp`)과 KT·삼성·LG·KIA 승률 사다리, 잔여 대진 표.
- **기록실**: 팀 순위, 팀간 승패표, 팀 타격, 팀 투수 원본 표. 헤더를 누르면 정렬됩니다.
- **도움말**: 산출 수식, GitHub 토큰, 일자별 수집.

## 기준일자 (`라이브 · 2026년 9월 20일 기준`)

오늘 날짜가 아닙니다. [KBO 일자별 팀 순위](https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx) HTML에서 `YYYY년 M월 D일`을 읽습니다. 그날까지 반영된 공식 순위표의 날짜입니다. 경기가 없거나 기록실이 아직 안 바뀌면 어제(또는 마지막 갱신일)로 남습니다.

페이지를 열면 먼저 `data/kbo.json` 스냅샷을 보여 주고, 라이브 수집이 되면 `라이브 · …`로 바꿉니다. 실패하면 `스냅샷 · …`을 유지합니다.

## 저장

GitHub Pages는 정적 사이트라 브라우저에서 레포에 쓰려면 **Contents Read and write** Personal Access Token이 필요합니다. 토큰은 이 브라우저 `localStorage`에만 남습니다.

- **토큰 저장**: 키 확인 후, 지금 화면의 순위표와 시뮬 결과를 레포에 올립니다.
- **지금 수집해서 저장**: KBO 기록실을 다시 받아 `data/kbo.json`, `data/daily/YYYY-MM-DD.json`을 갱신합니다.
- **시뮬레이션 시작**: `data/sim_result_기준일_횟수.json`과 `data/sim_latest.json`을 씁니다.

다시 열면 저장된 시뮬 파일 중 **기준일이 가장 최신**이고, 같으면 **횟수가 가장 많은** 결과를 자동으로 보여 줍니다.

## 로컬

```bash
python3 scripts/fetch_kbo.py
python3 -m http.server 8765
```

브라우저에서 http://127.0.0.1:8765/ 를 엽니다.
