const { drizzle } = require('drizzle-orm/node-postgres');
const { Pool } = require('pg');
const { pgTable, text, integer } = require('drizzle-orm/pg-core');
const { eq } = require('drizzle-orm');
const pool = new Pool({
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  host: process.env.SQL_HOST,
  database: process.env.SQL_DB_NAME,
});
const config = pgTable('config', {
  id: integer('id').primaryKey().default(1),
  gemini_api_key: text('gemini_api_key'),
  admin_hash: text('admin_hash'),
  admin_salt: text('admin_salt'),
  jwt_secret: text('jwt_secret'),
});
const db = drizzle(pool);

async function test() {
  try {
    const res = await db.select().from(config).where(eq(config.id, 1));
    console.log(res);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
test();
