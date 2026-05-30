require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/config/db');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: check current type of the id column
    const colRes = await client.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'users'
        AND column_name  = 'id'
    `);

    const currentType = colRes.rows[0]?.data_type ?? '(not found)';
    console.log(`Current users.id type: ${currentType}`);

    if (!['character varying', 'text'].includes(currentType)) {
      console.log('Altering users.id to VARCHAR(255)...');
      await client.query(`ALTER TABLE users ALTER COLUMN id TYPE VARCHAR(255)`);
      console.log('Column altered successfully.');
    } else {
      console.log('Column type already compatible — skipping ALTER.');
    }

    // Step 2: upsert the agent
    const uuid  = '00c9c5e5-5870-47f3-8359-7457d0e745f5';
    const email = 'mhmddishesh@gmail.com';
    const role  = 'agent';

    // password_hash is NOT NULL — use a sentinel for Supabase-Auth-managed users
    const placeholderHash = 'SUPABASE_AUTH_MANAGED';

    const res = await client.query(
      `INSERT INTO users (id, email, role, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET email         = EXCLUDED.email,
             role          = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash
       RETURNING id, email, role`,
      [uuid, email, role, placeholderHash]
    );

    await client.query('COMMIT');
    console.log('\n✅ Upsert complete:');
    console.table(res.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error — transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
