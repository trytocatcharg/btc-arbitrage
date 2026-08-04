import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
export async function createDbClient(databaseUrl) {
    const pool = mysql.createPool(databaseUrl);
    return drizzle(pool);
}
export async function validateDbConnection(databaseUrl) {
    const connection = await mysql.createConnection(databaseUrl);
    try {
        await connection.query('SELECT 1');
    }
    finally {
        await connection.end();
    }
}
//# sourceMappingURL=client.js.map