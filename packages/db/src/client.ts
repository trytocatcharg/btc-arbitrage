import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

export async function createDbClient(databaseUrl: string) {
  const pool = mysql.createPool(databaseUrl);
  return drizzle(pool);
}
