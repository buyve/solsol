-- Solana Memecoin Data Collection System
-- PostgreSQL Schema Initialization

-- 토큰 기본 정보
CREATE TABLE IF NOT EXISTS tokens (
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
CREATE TABLE IF NOT EXISTS price_history (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    price_sol NUMERIC(30, 18),
    price_usd NUMERIC(30, 18),
    sol_usd_rate NUMERIC(20, 8),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 시가총액/FDV
CREATE TABLE IF NOT EXISTS market_cap_history (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    market_cap_usd NUMERIC(30, 2),
    fdv_usd NUMERIC(30, 2),
    circulating_supply NUMERIC(38, 0),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 거래량 통계
CREATE TABLE IF NOT EXISTS volume_stats (
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
CREATE TABLE IF NOT EXISTS liquidity_pools (
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
CREATE TABLE IF NOT EXISTS holder_snapshots (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    total_holders INTEGER,
    top_10_percentage NUMERIC(5, 2),
    snapshot_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 상위 홀더
CREATE TABLE IF NOT EXISTS top_holders (
    id BIGSERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    wallet_address VARCHAR(44) NOT NULL,
    balance NUMERIC(38, 0),
    percentage NUMERIC(10, 6),
    rank SMALLINT,
    snapshot_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 트랜잭션 로그
CREATE TABLE IF NOT EXISTS transactions (
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
CREATE TABLE IF NOT EXISTS monitored_tokens (
    id SERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
    priority SMALLINT DEFAULT 1,
    update_interval_sec INTEGER DEFAULT 60,
    last_price_update TIMESTAMP WITH TIME ZONE,
    last_holder_update TIMESTAMP WITH TIME ZONE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint_address);
CREATE INDEX IF NOT EXISTS idx_tokens_platform ON tokens(launch_platform);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_token_time ON price_history(token_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_volume_token_time ON volume_stats(token_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pools_token ON liquidity_pools(token_id);
CREATE INDEX IF NOT EXISTS idx_pools_dex ON liquidity_pools(dex_name);
CREATE INDEX IF NOT EXISTS idx_holders_token_time ON holder_snapshots(token_id, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_top_holders_token_time ON top_holders(token_id, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_tx_token_time ON transactions(token_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_tx_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_monitored_priority ON monitored_tokens(priority DESC);

-- updated_at 자동 업데이트 트리거
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_tokens_updated_at ON tokens;
CREATE TRIGGER update_tokens_updated_at
    BEFORE UPDATE ON tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_pools_updated_at ON liquidity_pools;
CREATE TRIGGER update_pools_updated_at
    BEFORE UPDATE ON liquidity_pools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 완료 메시지
DO $$
BEGIN
    RAISE NOTICE 'Schema initialization completed successfully';
END $$;
