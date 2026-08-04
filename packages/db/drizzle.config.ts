import { defineConfig } from 'drizzle-kit';

const dbPort = parseDbPort(process.env.DB_PORT ?? '3306');

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DATABASE_HOST_NAME ?? '127.0.0.1',
    port: dbPort,
    user: process.env.DATABASE_USER_NAME ?? 'user',
    password: process.env.DATABASE_USER_PASSWORD ?? 'password',
    database: process.env.DATABASE_DB_NAME ?? 'btc_arbitrage'
  },
  strict: true,
  verbose: true
});

function parseDbPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('DB_PORT must be a positive integer');
  }
  return parsed;
}
