# Solana Memecoin Data Collection System

## PRD (Product Requirements Document)

**버전**: 2.0
**상태**: 확정
**최종 수정**: 2024-12-02
**변경 사항**: 기술 검증 결과 반영, API 버전 업데이트, 보안 패치 적용

-----

## 1. 개요

### 1.1 프로젝트 목적

Shyft.to API를 활용하여 Solana 블록체인 상의 밈코인 데이터를 실시간으로 수집, 저장, 분석하는 시스템 구축.

### 1.2 최종 목표

트레이딩 봇 개발을 위한 정확한 데이터 분석 기반 마련.

### 1.3 예상 비용

|항목                      |비용         |비고                          |
|------------------------|-----------|----------------------------|
|Shyft gRPC (Yellowstone)|$199/월     |Shared Network, 단일 IP 제한    |
|Shyft REST API          |무료 티어      |Rate Limit 확인 필요            |
|Jupiter Price API v3    |무료 (Lite)  |60 req/min, 2025.12.31 만료 예정|
|**총계**                  |**~$199/월**|                            |


> ⚠️ **주의**: Jupiter Lite API는 2025년 12월 31일 deprecated 예정. Pro 플랜 마이그레이션 계획 필요.

-----

## 2. 필수 수집 데이터

|#|데이터      |설명           |수집 주기             |데이터 소스                 |
|-|---------|-------------|------------------|-----------------------|
|1|실시간 가격   |SOL/USD 단위   |실시간 (gRPC)        |Shyft gRPC + Jupiter v3|
|2|시가총액     |가격 × 유통량     |실시간               |계산                     |
|3|FDV      |가격 × 총 공급량   |실시간               |계산                     |
|4|24시간 거래량 |매수/매도 건수 포함  |실시간 집계            |Shyft gRPC             |
|5|유동성 수준   |LP 풀 잔고      |실시간 (gRPC Pool 구독)|Shyft DeFi API         |
|6|홀더 리스트   |전체 지갑 목록     |동적 (1분~1시간)       |Shyft REST API         |
|7|Top 10 비율|상위 10 지갑 보유 %|동적 (홀더와 동일)       |계산                     |

### 2.1 홀더 업데이트 동적 주기

|토큰 상태|조건         |주기    |
|-----|-----------|------|
|신규   |생성 후 1시간 내 |**1분**|
|초기   |생성 후 24시간 내|5분    |
|활성   |홀더 < 1,000 |30분   |
|성숙   |홀더 ≥ 1,000 |1시간   |

-----

## 3. 모니터링 대상

### 3.1 런치패드

|플랫폼             |프로그램 주소                                      |상태                    |
|----------------|---------------------------------------------|----------------------|
|**Pump.fun**    |`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`|활성 (시장 점유율 55-62%)    |
|**PumpSwap AMM**|`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`|활성                    |
|**LetsBONK.fun**|`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`|활성 (Raydium LaunchLab)|
|Moonshot        |`MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG`|활성                    |


> ℹ️ **참고**: Pump.fun은 공식 API를 제공하지 않음. 온체인 데이터(gRPC) 또는 써드파티 서비스(Bitquery, Helius) 활용 필수.

### 3.2 예상 규모

- 일일 신규 토큰: 수천 개 (Pump.fun만 1,190만+ 토큰 생성 누적)
- 활성 모니터링 토큰: 동적 관리

-----

## 4. 데이터 활용 목적

### 4.1 분석 지표

- **고래 파악**: 상위 10 지갑 보유 비율로 덤핑 위험 평가
- **패닉셀/매집 감지**: 홀더 수 변화 추이
- **가짜 상승 감지**: 가격 상승 vs 거래량 비교
- **급등 전조 포착**: 거래량 급증 패턴

### 4.2 트레이딩 봇 연동

- 실시간 가격 피드
- 유동성 기반 슬리피지 계산
- 홀더 집중도 기반 리스크 평가

-----

## 5. 비기능 요구사항

### 5.1 성능

- 가격 업데이트 지연: < 1초 (gRPC)
- 데이터베이스 쿼리: < 100ms

### 5.2 안정성

- gRPC 연결 자동 재시도 (exponential backoff)
- Rate Limit 자동 관리
- 에러 로깅 및 알림

### 5.3 확장성

- 수천 개 토큰 동시 모니터링
- 우선순위 기반 업데이트 스케줄링
- gRPC 고볼륨 처리를 위한 멀티스레드 구조

### 5.4 보안 (신규)

- @solana/web3.js 1.95.8+ 필수 (공급망 공격 패치)
- API 키 환경변수 관리
- 민감 정보 로깅 금지

-----

## 6. 구현 단계 요약

|Phase |내용            |태스크 수 |
|------|--------------|------|
|1     |기반 구축         |4     |
|2     |Shyft 클라이언트   |3     |
|3     |실시간 데이터 (gRPC)|4     |
|4     |가격 시스템        |4     |
|5     |거래량/시총        |2     |
|6     |홀더 분석         |3     |
|7     |작업 큐 및 스케줄링   |3     |
|**총계**|              |**23**|

-----

## 7. 선행 조건

1. **Shyft 계정 생성**: https://shyft.to
1. **gRPC 플랜 결제**: $199/월 (Discord 통해 무료 트라이얼 가능)
1. **API 키 발급**: REST API + gRPC 토큰
1. **로컬 환경**: Docker, Node.js 18+, Redis 7+

-----

## 8. 기술적 제약사항 (신규)

### 8.1 API 제한

|API                    |제한                   |대응 방안               |
|-----------------------|---------------------|--------------------|
|Jupiter Price v3 (Lite)|60 req/min           |배치 쿼리 50개/요청 활용     |
|Shyft gRPC $199        |단일 IP 연결             |아키텍처 설계 시 고려        |
|저유동성 토큰                |Jupiter 가격 null 반환 가능|온체인 reserve fallback|

### 8.2 알려진 이슈

- @shyft-to/js 패키지 1년간 미업데이트 (0.2.40)
- Jupiter Lite API 2025.12.31 deprecated 예정
- Pump.fun 공식 API 미제공

-----

## 9. 참고 문서

- [TRD.md](./TRD.md) - 기술 설계 문서
- [PROGRESS.md](./PROGRESS.md) - 구현 진행 상황
- [Shyft API Docs](https://docs.shyft.to)
- [Shyft gRPC Docs](https://docs.shyft.to/solana-yellowstone-grpc/docs)
- [Jupiter Price API v3](https://dev.jup.ag/docs/price/v3)
