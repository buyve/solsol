/**
 * Database Seed Script
 * Inserts sample data for testing and development
 *
 * Usage: npm run seed
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://solsol:solsol_password@localhost:5432/solsol',
});

// Sample token data for testing
const sampleTokens = [
  {
    mint_address: 'So11111111111111111111111111111111111111112',
    name: 'Wrapped SOL',
    symbol: 'SOL',
    decimals: 9,
    total_supply: '1000000000000000000',
    launch_platform: 'native',
  },
  {
    mint_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    total_supply: '10000000000000000',
    launch_platform: 'native',
  },
  {
    mint_address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    name: 'Bonk',
    symbol: 'BONK',
    decimals: 5,
    total_supply: '100000000000000000000',
    launch_platform: 'raydium',
  },
  // Sample memecoin for testing
  {
    mint_address: 'TestMeme111111111111111111111111111111111111',
    name: 'Test Memecoin',
    symbol: 'TMEME',
    decimals: 9,
    total_supply: '1000000000000000000',
    launch_platform: 'pump.fun',
  },
];

// Sample pool data
const samplePools = [
  {
    pool_address: 'TestPool1111111111111111111111111111111111111',
    dex_name: 'raydium',
    base_mint: 'TestMeme111111111111111111111111111111111111',
    quote_mint: 'So11111111111111111111111111111111111111112',
    base_reserve: '1000000000000000',
    quote_reserve: '10000000000',
    liquidity_usd: 50000,
  },
];

async function seed(): Promise<void> {
  const client = await pool.connect();

  try {
    console.log('Starting database seed...');

    await client.query('BEGIN');

    // Insert tokens
    console.log('Inserting sample tokens...');
    for (const token of sampleTokens) {
      await client.query(
        `INSERT INTO tokens (mint_address, name, symbol, decimals, total_supply, launch_platform)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (mint_address) DO UPDATE SET
           name = EXCLUDED.name,
           symbol = EXCLUDED.symbol,
           total_supply = EXCLUDED.total_supply,
           updated_at = NOW()`,
        [
          token.mint_address,
          token.name,
          token.symbol,
          token.decimals,
          token.total_supply,
          token.launch_platform,
        ]
      );
      console.log(`  - Inserted/updated: ${token.symbol}`);
    }

    // Get token IDs for pools
    const testTokenResult = await client.query(
      'SELECT id FROM tokens WHERE mint_address = $1',
      ['TestMeme111111111111111111111111111111111111']
    );

    if (testTokenResult.rows.length > 0) {
      const tokenId = testTokenResult.rows[0].id;

      // Insert pools
      console.log('Inserting sample liquidity pools...');
      for (const poolData of samplePools) {
        await client.query(
          `INSERT INTO liquidity_pools (token_id, pool_address, dex_name, base_mint, quote_mint, base_reserve, quote_reserve, liquidity_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (pool_address) DO UPDATE SET
             base_reserve = EXCLUDED.base_reserve,
             quote_reserve = EXCLUDED.quote_reserve,
             liquidity_usd = EXCLUDED.liquidity_usd,
             updated_at = NOW()`,
          [
            tokenId,
            poolData.pool_address,
            poolData.dex_name,
            poolData.base_mint,
            poolData.quote_mint,
            poolData.base_reserve,
            poolData.quote_reserve,
            poolData.liquidity_usd,
          ]
        );
        console.log(`  - Inserted/updated pool: ${poolData.pool_address.substring(0, 10)}...`);
      }

      // Insert sample price history
      console.log('Inserting sample price history...');
      await client.query(
        `INSERT INTO price_history (token_id, price_sol, price_usd, sol_usd_rate)
         VALUES ($1, $2, $3, $4)`,
        [tokenId, 0.000001, 0.0002, 200]
      );

      // Insert sample volume stats
      console.log('Inserting sample volume stats...');
      await client.query(
        `INSERT INTO volume_stats (token_id, volume_24h_sol, volume_24h_usd, buy_count_24h, sell_count_24h)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenId, 100, 20000, 150, 120]
      );

      // Insert sample holder snapshot
      console.log('Inserting sample holder snapshot...');
      await client.query(
        `INSERT INTO holder_snapshots (token_id, mint_address, total_holders, top_10_percentage, top_20_percentage, top_50_percentage, gini_coefficient)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tokenId, 'TestMeme111111111111111111111111111111111111', 500, 45.5, 60.2, 75.8, 0.65]
      );

      // Add to monitored tokens
      console.log('Adding test token to monitored list...');
      await client.query(
        `INSERT INTO monitored_tokens (token_id, priority, update_interval_sec)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [tokenId, 1, 30]
      );
    }

    await client.query('COMMIT');
    console.log('\nDatabase seed completed successfully!');

    // Print summary
    const tokenCount = await client.query('SELECT COUNT(*) FROM tokens');
    const poolCount = await client.query('SELECT COUNT(*) FROM liquidity_pools');
    const monitoredCount = await client.query('SELECT COUNT(*) FROM monitored_tokens');

    console.log('\nDatabase summary:');
    console.log(`  - Tokens: ${tokenCount.rows[0].count}`);
    console.log(`  - Liquidity Pools: ${poolCount.rows[0].count}`);
    console.log(`  - Monitored Tokens: ${monitoredCount.rows[0].count}`);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  try {
    await seed();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
