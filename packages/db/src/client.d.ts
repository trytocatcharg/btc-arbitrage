import mysql from 'mysql2/promise';
export declare function createDbClient(databaseUrl: string): Promise<import("drizzle-orm/mysql2").MySql2Database<Record<string, never>> & {
    $client: mysql.Pool;
}>;
export declare function validateDbConnection(databaseUrl: string): Promise<void>;
//# sourceMappingURL=client.d.ts.map