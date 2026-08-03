import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://user:password@127.0.0.1:3306/btc_arbitrage'
  },
  strict: true,
  verbose: true
});
