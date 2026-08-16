require('./load-env');

const mysql = require('mysql2/promise');

// 数据库配置（请根据实际情况修改）
const DB_CONFIG = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'chiyi',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'gpt',
};

async function resetDatabase() {
    console.log('正在准备重置数据库...');
    console.log(`目标数据库: ${DB_CONFIG.database} at ${DB_CONFIG.host}`);

    let connection;
    try {
        connection = await mysql.createConnection(DB_CONFIG);
        console.log('连接成功。');

        // 1. 获取所有表名
        const [tables] = await connection.query('SHOW TABLES');
        const tableNames = tables.map(row => Object.values(row)[0]);

        if (tableNames.length === 0) {
            console.log('数据库已经是空的，无需删除。');
        } else {
            console.log(`发现 ${tableNames.length} 个表: ${tableNames.join(', ')}`);

            // 2. 禁用外键检查以允许删除
            await connection.query('SET FOREIGN_KEY_CHECKS = 0');

            // 3. 删除所有表
            for (const tableName of tableNames) {
                console.log(`正在删除表: ${tableName}...`);
                await connection.query(`DROP TABLE IF EXISTS \`${tableName}\``);
            }

            // 4. 恢复外键检查
            await connection.query('SET FOREIGN_KEY_CHECKS = 1');
            console.log('所有表已成功删除。');
        }

        console.log('\n重置完成！');
        console.log('提示：现在启动 node server.js，系统会自动根据 mysql-schema.sql 重建最新的表结构。');

    } catch (error) {
        console.error('重置失败:', error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
        process.exit();
    }
}

// 运行前确认
console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
console.log('警告：此操作将永久删除数据库中所有数据（包括 CDK、资产等）！');
console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');

// 如果是直接运行则执行
if (require.main === module) {
    resetDatabase();
}
