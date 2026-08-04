import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: mysql.Pool | null = null;

export async function getDb() {
  if (_db) return _db;

  _pool = mysql.createPool({
    host: process.env.DATABASE_HOST_NAME ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DATABASE_USER_NAME ?? 'root',
    password: process.env.DATABASE_USER_PASSWORD ?? '',
    database: process.env.DATABASE_DB_NAME ?? 'wolfe_trading',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  _db = drizzle(_pool, { schema, mode: 'default' });
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export async function testConnection() {
  try {
    if (_pool) {
      await _pool.execute("SELECT 1");
      return true;
    }
    return false;
  } catch (error) {
    console.error("❌ Error al probar conexión:", error);
    return false;
  }
}

export { schema };
