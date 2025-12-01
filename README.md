# Solana Memecoin Data Collection System

Shyft.to API를 활용한 Solana 밈코인 실시간 데이터 수집/분석 시스템

## 개요

- **목적**: 트레이딩 봇 개발을 위한 데이터 분석 기반 구축
- **대상**: Pump.fun, Bonk.fun 등 런치패드의 신규 토큰
- **예상 비용**: ~$199/월 (Shyft gRPC)

## 수집 데이터

| 데이터 | 수집 방법 |
|--------|----------|
| 실시간 가격 (SOL/USD) | gRPC 스왑 이벤트 |
| 시가총액/FDV | 가격 × 공급량 계산 |
| 24시간 거래량 | Redis Sliding Window |
| 유동성 수준 | DeFi API |
| 전체 홀더 리스트 | REST API (페이지네이션) |
| Top 10 지갑 비율 | 홀더 데이터 계산 |

## 기술 스택

- **언어**: TypeScript / Node.js 18+
- **데이터베이스**: PostgreSQL 15+ / Redis 7+
- **API**: Shyft gRPC, REST API, Jupiter Price API
- **작업 큐**: Bull (Redis 기반)

## 시작하기

### 1. 사전 요구사항

- Node.js 18+
- Docker & Docker Compose
- Shyft API 키 (https://shyft.to)

### 2. 설치

```bash
# 의존성 설치
pnpm install

# 환경 변수 설정
cp .env.example .env
# .env 파일 편집하여 API 키 입력

# Docker 컨테이너 실행 (PostgreSQL, Redis)
docker-compose up -d

# 데이터베이스 마이그레이션
pnpm run migrate

# 애플리케이션 실행
pnpm run dev
```

### 3. 환경 변수

```env
# Shyft API
SHYFT_API_KEY=your_api_key
SHYFT_GRPC_ENDPOINT=your_grpc_endpoint
SHYFT_GRPC_TOKEN=your_grpc_token

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/solsol
REDIS_URL=redis://localhost:6379
```

## 문서

- [PRD.md](./docs/PRD.md) - 제품 요구사항
- [TRD.md](./docs/TRD.md) - 기술 설계
- [PROGRESS.md](./docs/PROGRESS.md) - 구현 진행 상황

## 프로젝트 구조

```
solsol/
├── docs/           # 문서
├── src/
│   ├── config/     # 설정
│   ├── services/   # 비즈니스 로직
│   │   ├── collectors/   # 데이터 수집
│   │   ├── processors/   # 데이터 처리
│   │   └── external/     # 외부 API 클라이언트
│   ├── queues/     # 작업 큐
│   ├── workers/    # 워커
│   ├── repositories/  # DB 액세스
│   ├── cache/      # 캐시 관리
│   ├── utils/      # 유틸리티
│   └── types/      # 타입 정의
├── scripts/        # 스크립트
└── tests/          # 테스트
```

## 라이선스

Private
