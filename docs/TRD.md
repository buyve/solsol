# Solana Memecoin Data Collection System

## TRD (Technical Requirements Document)

**버전**: 2.0
**상태**: 확정
**최종 수정**: 2024-12-02
**변경 사항**: Jupiter API v6→v3 마이그레이션, @solana/web3.js 보안 패치, Bull→BullMQ 전환

-----

## 1. 기술 스택

### 1.1 언어 및 런타임

```
언어: TypeScript 5.x
런타임: Node.js >= 18.x (LTS)
패키지 매니저: pnpm
```

### 1.2 주요 의존성

```json
{
  "@shyft-to/js": "^0.2.40",
  "@solana/web3.js": "^1.95.8",
  "@triton-one/yellowstone-grpc": "^4.0.2",
  "pg": "^8.11.0",
  "redis": "^4.6.0",
  "bullmq": "^5.65.0",
  "express": "^4.18.0",
  "winston": "^3.11.0",
  "dotenv": "^16.3.0"
}
```

> ⚠️ **보안 경고**: @solana/web3.js 1.95.6, 1.95.7에 공급망 공격으로 인한 악성 코드 포함. **반드시 1.95.8 이상 사용**.

### 1.3 인프라

|컴포넌트  |기술                     |버전 |비고                 |
|------|-----------------------|---|-------------------|
|영구 저장소|PostgreSQL             |15+|                   |
|캐시/실시간|Redis                  |7+ |BullMQ 요구사항: 6.2.0+|
|작업 큐  |BullMQ (Redis 기반)      |5.x|Bull은 유지보수 모드      |
|컨테이너  |Docker + Docker Compose|-  |                   |

-----

## 2. 데이터베이스 스키마

### 2.1 PostgreSQL

```sql
-- 토큰 기본 정보
CREATE TABLE tokens (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    symbol VARCHAR(50),
    decimals SMALLINT DEFAULT 9,
    total_supply NUMERIC(38, 0),
    metadata_uri TEXT,
    launch_platform VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- 가격 히스토리
CREATE TABLE price_history (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    price_sol NUMERIC(30, 18),
    price_usd NUMERIC(30, 18),
    sol_usd_rate NUMERIC(20, 8),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 시가총액/FDV
CREATE TABLE market_cap_history (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    market_cap_usd NUMERIC(30, 2),
    fdv_usd NUMERIC(30, 2),
    circulating_supply NUMERIC(38, 0),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 거래량 통계
CREATE TABLE volume_stats (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    volume_24h_sol NUMERIC(30, 18) DEFAULT 0,
    volume_24h_usd NUMERIC(30, 2) DEFAULT 0,
    buy_count_24h INTEGER DEFAULT 0,
    sell_count_24h INTEGER DEFAULT 0,
    buy_volume_24h_sol NUMERIC(30, 18) DEFAULT 0,
    sell_volume_24h_sol NUMERIC(30, 18) DEFAULT 0,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 유동성 풀
CREATE TABLE liquidity_pools (
    id SERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    pool_address VARCHAR(44) UNIQUE NOT NULL,
    dex_name VARCHAR(50) NOT NULL,
    base_mint VARCHAR(44) NOT NULL,
    quote_mint VARCHAR(44) NOT NULL,
    base_reserve NUMERIC(38, 0),
    quote_reserve NUMERIC(38, 0),
    liquidity_usd NUMERIC(30, 2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 홀더 스냅샷
CREATE TABLE holder_snapshots (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    total_holders INTEGER,
    top_10_percentage NUMERIC(5, 2),
    snapshot_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 상위 홀더
CREATE TABLE top_holders (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    wallet_address VARCHAR(44) NOT NULL,
    balance NUMERIC(38, 0),
    percentage NUMERIC(10, 6),
    rank SMALLINT,
    snapshot_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 트랜잭션 로그
CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    signature VARCHAR(88) UNIQUE NOT NULL,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    pool_id INTEGER REFERENCES liquidity_pools(id),
    tx_type VARCHAR(20) NOT NULL,
    wallet_address VARCHAR(44),
    amount_token NUMERIC(38, 0),
    amount_sol NUMERIC(30, 18),
    price_at_tx NUMERIC(30, 18),
    block_time TIMESTAMP WITH TIME ZONE,
    slot BIGINT
);

-- 모니터링 대상
CREATE TABLE monitored_tokens (
    id SERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    priority SMALLINT DEFAULT 1,
    update_interval_sec INTEGER DEFAULT 60,
    last_price_update TIMESTAMP WITH TIME ZONE,
    last_holder_update TIMESTAMP WITH TIME ZONE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스
CREATE INDEX idx_tokens_mint ON tokens(mint_address);
CREATE INDEX idx_tokens_platform ON tokens(launch_platform);
CREATE INDEX idx_price_history_token_time ON price_history(token_id, timestamp DESC);
CREATE INDEX idx_volume_token_time ON volume_stats(token_id, timestamp DESC);
CREATE INDEX idx_pools_token ON liquidity_pools(token_id);
CREATE INDEX idx_holders_token_time ON holder_snapshots(token_id, snapshot_time DESC);
CREATE INDEX idx_tx_token_time ON transactions(token_id, block_time DESC);
```

### 2.2 Redis 구조

```
# 실시간 가격 캐시 (TTL: 30초)
price:{mint_address} -> JSON { price_sol, price_usd, sol_usd, updated_at }

# 24시간 거래량 (Sorted Set, score = timestamp)
volume:24h:{mint_address} -> ZADD timestamp tx_data_json

# 활성 풀 목록
pools:active -> SET of pool_addresses

# 풀 정보 캐시 (TTL: 5분)
pool:{pool_address} -> JSON { base_reserve, quote_reserve, liquidity_usd }

# SOL/USD 환율 (TTL: 10초)
rate:sol:usd -> "189.50"
```

-----

## 3. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                           │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Shyft gRPC   │ Shyft REST   │ Shyft DeFi   │ Jupiter v3    │
│ (실시간)      │ (토큰/홀더)   │ (풀 정보)     │ (SOL/USD)     │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬───────┘
       │              │              │               │
       v              v              v               v
┌─────────────────────────────────────────────────────────────┐
│                      COLLECTORS                             │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Transaction  │ TokenInfo    │ Pool         │ Holder        │
│ Streamer     │ Fetcher      │ Monitor      │ Scanner       │
│ (worker_threads)                                            │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬───────┘
       │              │              │               │
       v              v              v               v
┌─────────────────────────────────────────────────────────────┐
│               MESSAGE QUEUE (BullMQ/Redis 7+)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────┐
│                      PROCESSORS                             │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Price        │ Volume       │ MarketCap    │ Holder        │
│ Calculator   │ Aggregator   │ Calculator   │ Analyzer      │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬───────┘
       │              │              │               │
       v              v              v               v
┌─────────────────────────────────────────────────────────────┐
│                      DATA STORAGE                           │
├─────────────────────────────┬───────────────────────────────┤
│      PostgreSQL (영구)       │      Redis (캐시/실시간)       │
└─────────────────────────────┴───────────────────────────────┘
```

-----

## 4. API 연동 상세

### 4.1 Shyft gRPC (Yellowstone)

**용도**: 실시간 트랜잭션/계정 스트리밍

```typescript
import Client from "@triton-one/yellowstone-grpc";

// 지역별 엔드포인트 선택 가능
// - https://grpc.ams.shyft.to (Amsterdam)
// - https://grpc.fra.shyft.to (Frankfurt)
// - etc.

const client = new Client(
  "https://grpc.ams.shyft.to",  // Shyft gRPC 엔드포인트
  "YOUR-ACCESS-XTOKEN",         // x-token 인증
  undefined
);

// Pump.fun 트랜잭션 구독
const subscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    pumpfun: {
      vote: false,
      failed: false,
      accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
    }
  },
  blocks: {},
  blocksMeta: {},
  commitment: 1  // PROCESSED
};

// LetsBONK.fun (Raydium LaunchLab) 구독
const bonkSubscribe = {
  transactions: {
    letsbonk: {
      vote: false,
      failed: false,
      accountInclude: ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"]
    }
  }
};
```

> ⚠️ **제한사항**: $199/월 플랜은 Shared Network로 단일 IP 연결 제한. 고볼륨 처리 시 `worker_threads` 활용 권장.

### 4.2 Shyft REST API

**용도**: 토큰 정보, 홀더 리스트

```typescript
// 토큰 정보 조회
const tokenInfo = await fetch(
  `https://api.shyft.to/sol/v1/token/get_info?network=mainnet-beta&token_address=${mint}`,
  { headers: { 'x-api-key': SHYFT_API_KEY } }
);

// 홀더 리스트 - SDK 사용 권장 (getOwners 메서드)
import { ShyftSdk, Network } from '@shyft-to/js';

const shyft = new ShyftSdk({ apiKey: SHYFT_API_KEY, network: Network.Mainnet });

// 페이지네이션 지원
async function getAllHolders(mint: string): Promise<Holder[]> {
  let page = 1;
  const allHolders: Holder[] = [];

  while (true) {
    const response = await shyft.token.getOwners({
      tokenAddress: mint,
      page,
      size: 100
    });

    allHolders.push(...response);

    if (response.length < 100) break;
    page++;
    await sleep(100); // Rate limit 준수
  }

  return allHolders;
}
```

### 4.3 Shyft DeFi API

**용도**: 유동성 풀 정보

```typescript
// 토큰의 모든 풀 조회
const pools = await fetch(
  `https://defi.shyft.to/v0/pools/get_by_token?token=${mint}&limit=100`,
  { headers: { 'x-api-key': SHYFT_API_KEY } }
);

// 지원 DEX 목록:
// - pumpFunAmm: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// - raydiumLaunchpad: LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
// - raydiumAmmV4, raydiumClmm, raydiumCpmm
// - orca, orcaWhirlpool
// - meteora, meteoraDlmm
```

### 4.4 Jupiter Price API v3 (업데이트됨)

**용도**: SOL/USD 환율 및 토큰 가격

```typescript
// ⚠️ 기존 v6 API (deprecated)
// const solPrice = await fetch('https://price.jup.ag/v6/price?ids=...');

// ✅ 현재 권장 API (v3 Lite)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// 단일 토큰 조회
const solPrice = await fetch(
  `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`
);

// 배치 조회 (최대 100개, 50개 권장)
const tokenMints = ['token1', 'token2', ...]; // 최대 100개
const batchPrice = await fetch(
  `https://lite-api.jup.ag/price/v3?ids=${tokenMints.join(',')}`
);

// 응답 구조
interface JupiterPriceResponse {
  data: {
    [mint: string]: {
      id: string;
      type: string;
      price: string;
      // extraInfo 포함 시 추가 필드
    };
  };
  timeTaken: number;
}
```

> ⚠️ **주의사항**:
>
> - `lite-api.jup.ag`는 2025년 12월 31일 deprecated 예정
> - 7일 이내 거래 없거나 저유동성 토큰은 `null` 반환 가능
> - Rate Limit: 60 req/min (무료), 배치 쿼리로 최적화 필요

### 4.5 Fallback: 온체인 가격 계산

**용도**: Jupiter API 실패 시 대체

```typescript
// Raydium AMM V4 풀에서 직접 가격 계산
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

async function getOnchainPrice(poolAddress: string): Promise<number | null> {
  const accountInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!accountInfo) return null;

  // AMM V4 레이아웃 파싱 (실제 구현 시 @raydium-io/raydium-sdk 활용)
  const { baseReserve, quoteReserve, baseDecimals, quoteDecimals } = parseAmmLayout(accountInfo.data);

  return calculatePrice(baseReserve, quoteReserve, baseDecimals, quoteDecimals);
}

// Orca Whirlpool에서 직접 가격 읽기
function getWhirlpoolPrice(sqrtPriceX64: bigint): number {
  return Math.pow(Number(sqrtPriceX64) / Math.pow(2, 64), 2);
}
```

-----

## 5. 핵심 알고리즘

### 5.1 AMM 가격 계산

```typescript
// Constant Product Formula: x * y = k
function calculateTokenPriceInSol(
  baseReserve: bigint,      // 토큰 reserve
  quoteReserve: bigint,     // SOL reserve
  baseDecimals: number,     // 보통 6 또는 9
  quoteDecimals: number     // SOL은 9
): number {
  const adjustedBase = Number(baseReserve) / Math.pow(10, baseDecimals);
  const adjustedQuote = Number(quoteReserve) / Math.pow(10, quoteDecimals);
  return adjustedQuote / adjustedBase;
}

// USD 변환
const priceUsd = priceSol * solUsdRate;

// Raydium AMM V4 실제 reserve 계산 (OpenBook 통합)
// vault_balance + open_orders_total - need_take_pnl
```

### 5.2 시가총액/FDV 계산

```typescript
// 시가총액 = 가격 × 유통량
const marketCap = priceUsd * circulatingSupply;

// FDV = 가격 × 총 공급량
const fdv = priceUsd * totalSupply;

// Pump.fun: 1B 고정 공급
const PUMPFUN_SUPPLY = 1_000_000_000;
const pumpfunFDV = priceUsd * PUMPFUN_SUPPLY;
```

### 5.3 24시간 거래량 집계

```typescript
// Redis Sliding Window
async function recordTransaction(mint: string, tx: TxData) {
  const key = `volume:24h:${mint}`;
  await redis.zadd(key, tx.timestamp, JSON.stringify(tx));

  // 24시간 이전 데이터 정리
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await redis.zremrangebyscore(key, 0, cutoff);
}

async function get24hVolume(mint: string): Promise<VolumeStats> {
  const key = `volume:24h:${mint}`;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const txs = await redis.zrangebyscore(key, cutoff, '+inf');

  let buyVolume = 0, sellVolume = 0, buyCount = 0, sellCount = 0;

  for (const txJson of txs) {
    const tx = JSON.parse(txJson);
    if (tx.type === 'buy') {
      buyVolume += tx.amountSol;
      buyCount++;
    } else {
      sellVolume += tx.amountSol;
      sellCount++;
    }
  }

  return { buyVolume, sellVolume, buyCount, sellCount, total: buyVolume + sellVolume };
}
```

### 5.4 Top 10 홀더 비율 계산

```typescript
function calculateTop10Percentage(
  holders: Holder[],
  totalSupply: bigint
): { percentage: number; holders: Holder[] } {
  const sorted = holders.sort((a, b) => Number(b.balance - a.balance));
  const top10 = sorted.slice(0, 10);
  const top10Sum = top10.reduce((sum, h) => sum + BigInt(h.balance), 0n);
  const percentage = Number(top10Sum * 10000n / totalSupply) / 100;

  return { percentage, holders: top10 };
}
```

-----

## 6. 프로젝트 구조

```
solsol/
├── package.json
├── tsconfig.json
├── .env.example
├── .env
├── docker-compose.yml
├── README.md
│
├── docs/
│   ├── PRD.md
│   ├── TRD.md
│   └── PROGRESS.md
│
├── src/
│   ├── index.ts                    # 진입점
│   │
│   ├── config/
│   │   ├── index.ts
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   └── shyft.ts
│   │
│   ├── services/
│   │   ├── collectors/
│   │   │   ├── TransactionStreamer.ts   # worker_threads 활용
│   │   │   ├── NewTokenDetector.ts
│   │   │   ├── TokenInfoFetcher.ts
│   │   │   ├── PoolMonitor.ts
│   │   │   └── HolderScanner.ts
│   │   │
│   │   ├── processors/
│   │   │   ├── PriceCalculator.ts
│   │   │   ├── VolumeAggregator.ts
│   │   │   ├── MarketCapCalculator.ts
│   │   │   └── HolderAnalyzer.ts
│   │   │
│   │   └── external/
│   │       ├── ShyftClient.ts
│   │       ├── GrpcClient.ts
│   │       ├── JupiterPriceClient.ts    # v3 API
│   │       └── OnchainPriceOracle.ts    # Fallback
│   │
│   ├── queues/
│   │   ├── index.ts
│   │   ├── priceUpdateQueue.ts
│   │   ├── holderScanQueue.ts
│   │   └── poolMonitorQueue.ts
│   │
│   ├── workers/
│   │   ├── PriceUpdateWorker.ts
│   │   ├── HolderScanWorker.ts
│   │   ├── PoolMonitorWorker.ts
│   │   └── GrpcStreamWorker.ts          # worker_threads
│   │
│   ├── repositories/
│   │   ├── TokenRepository.ts
│   │   ├── PriceRepository.ts
│   │   ├── PoolRepository.ts
│   │   └── HolderRepository.ts
│   │
│   ├── cache/
│   │   ├── PriceCache.ts
│   │   ├── PoolCache.ts
│   │   └── RateLimiter.ts
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── solana.ts
│   │   └── math.ts
│   │
│   └── types/
│       ├── token.ts
│       ├── pool.ts
│       ├── holder.ts
│       └── transaction.ts
│
├── scripts/
│   ├── migrate.ts
│   ├── seed.ts
│   └── backfill.ts
│
└── tests/
    ├── unit/
    └── integration/
```

-----

## 7. 환경 변수

```env
# .env.example

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/solsol
REDIS_URL=redis://localhost:6379

# Shyft API
SHYFT_API_KEY=your_api_key_here
SHYFT_GRPC_ENDPOINT=https://grpc.ams.shyft.to
SHYFT_GRPC_TOKEN=your_grpc_xtoken

# Jupiter API (v3)
JUPITER_API_URL=https://lite-api.jup.ag/price/v3

# Solana RPC (백업용)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Application
NODE_ENV=development
LOG_LEVEL=info
PORT=3000

# Worker Threads
GRPC_WORKER_COUNT=2
```

-----

## 8. 업데이트 주기 설정

```typescript
const UPDATE_INTERVALS = {
  PRICE: {
    HOT: 5_000,        // 상위 100 토큰: 5초
    ACTIVE: 30_000,    // 활성 토큰: 30초
    INACTIVE: 300_000  // 비활성 토큰: 5분
  },
  HOLDERS: {
    NEW: 60_000,           // 신규 (생성 1시간 내): 1분
    EARLY: 300_000,        // 초기 (생성 24시간 내): 5분
    ACTIVE: 1_800_000,     // 활성 (홀더 < 1000): 30분
    MATURE: 3_600_000      // 성숙 (홀더 >= 1000): 1시간
  },
  POOLS: {
    REALTIME: 0        // 실시간 (gRPC 구독)
  },
  SOL_USD: 10_000      // 10초
};

// 홀더 업데이트 주기 결정 함수
function getHolderUpdateInterval(token: Token): number {
  const ageMs = Date.now() - token.createdAt.getTime();
  const ONE_HOUR = 3600_000;
  const ONE_DAY = 24 * ONE_HOUR;

  if (ageMs < ONE_HOUR) return UPDATE_INTERVALS.HOLDERS.NEW;        // 1분
  if (ageMs < ONE_DAY) return UPDATE_INTERVALS.HOLDERS.EARLY;       // 5분
  if (token.holderCount < 1000) return UPDATE_INTERVALS.HOLDERS.ACTIVE;  // 30분
  return UPDATE_INTERVALS.HOLDERS.MATURE;                           // 1시간
}

const CACHE_TTL = {
  PRICE: 30,           // 30초
  TOKEN_INFO: 3600,    // 1시간
  POOL_INFO: 300,      // 5분
  SOL_USD: 10,         // 10초
  HOLDERS_TOP20: 60    // 1분 (신규 토큰 기준)
};
```

-----

## 9. 런치패드 프로그램 주소 (검증됨)

|플랫폼                    |프로그램 주소                                       |용도               |
|-----------------------|----------------------------------------------|-----------------|
|Pump.fun (메인)          |`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |토큰 생성/거래         |
|PumpSwap AMM           |`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |AMM 풀            |
|Pump.fun 수수료           |`pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |수수료 처리           |
|LetsBONK.fun           |`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` |Raydium LaunchLab|
|LetsBONK Creator Filter|`FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1`|생성자 필터           |
|Moonshot               |`MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG` |토큰 생성/거래         |
|Raydium AMM V4         |`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`|Legacy AMM       |
|Raydium CPMM           |`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`|Standard Pool    |
|Raydium CLMM           |`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`|Concentrated     |
|Orca Whirlpool         |`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |CLMM             |

-----

## 10. 참고 자료

- [Shyft API Reference](https://docs.shyft.to/solana-apis/api-reference)
- [Shyft Yellowstone gRPC](https://docs.shyft.to/solana-yellowstone-grpc/docs)
- [Shyft JS SDK](https://www.npmjs.com/package/@shyft-to/js)
- [Shyft DeFi API](https://docs.shyft.to/solana-defi-apis/defi-apis)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Jupiter Price API v3](https://dev.jup.ag/docs/price/v3)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [Raydium SDK](https://github.com/raydium-io/raydium-sdk)
