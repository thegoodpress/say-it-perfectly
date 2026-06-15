const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_2UPoyuIFxw8r@ep-polished-heart-ap9npxot.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require'
});

async function test() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('Connection successful:', res.rows[0]);
    
    await pool.query(`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
      confirmation_code TEXT UNIQUE,
      speech_data TEXT,
      speech_text TEXT,
      is_paid INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('Table orders verified/created.');
  } catch (err) {
    console.error('Connection failed:', err);
  } finally {
    await pool.end();
  }
}

test();
