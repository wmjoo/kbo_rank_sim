# KBO 순위 시뮬레이터

KBO 공식 기록실 표를 가져와 보여주는 모바일용 페이지입니다.

- 페이지: https://wmjoo.github.io/kbo_rank_sim/
- 저장소: https://github.com/wmjoo/kbo_rank_sim

- **시뮬레이터**: 현재 승률·피타고리안 승률로 잔여 경기를 추정하고, LG 잔여 조합과 삼성/KIA 최종승률 사다리를 보여줍니다.
- **기록실**: 팀 순위, 팀 타격, 팀 투수 원본 표.
- **관리자**: 웹에서 KBO 표를 수집해 `data/daily/YYYY-MM-DD.json`으로 저장합니다. repo 권한 GitHub 토큰이 필요합니다.

모든 표 헤더를 누르면 정렬됩니다.

```bash
python3 scripts/fetch_kbo.py
```
