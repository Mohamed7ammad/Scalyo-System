require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const pool   = require('../src/config/db');

async function seed() {
  // Create admin
  const adminHash = await bcrypt.hash('admin123', 10);
  await pool.query(
    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
    ['admin@example.com', adminHash, 'admin']
  );
  console.log('Admin created  -> admin@example.com  / admin123');

  // Create a sample agent
  const agentHash = await bcrypt.hash('agent123', 10);
  await pool.query(
    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
    ['agent@example.com', agentHash, 'agent']
  );
  console.log('Agent created  -> agent@example.com  / agent123');

  await pool.end();
  console.log('\nChange these passwords immediately after first login!');
}

seed().catch((err) => { console.error(err); process.exit(1); });
