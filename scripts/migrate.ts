import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://solsol:solsol_password@localhost:5432/solsol';

  console.log('Starting database migration...');

  const pool = new pg.Pool({
    connectionString: databaseUrl,
  });

  try {
    const sqlPath = join(__dirname, 'init.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('Executing migration script...');
    await pool.query(sql);

    console.log('Migration completed successfully!');

    // Verify tables were created
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('\nCreated tables:');
    result.rows.forEach((row) => {
      console.log(`  - ${row.table_name}`);
    });

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
