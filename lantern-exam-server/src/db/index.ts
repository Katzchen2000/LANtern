import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  host: process.env.SQL_HOST,
  database: process.env.SQL_DB_NAME,
  max: 5,
  idleTimeoutMillis: 2000,
  connectionTimeoutMillis: 3000,
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle pg client', err);
});

export const db = drizzle(pool, { schema });
