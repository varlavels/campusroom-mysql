const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

(async () => {
  const conn = await mysql.createConnection({
    host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD,
  });
  const [[info]] = await conn.query('SELECT VERSION() AS version, @@hostname AS host, @@port AS port');
  console.log('Server:', info);
  console.log('Databases:', (await conn.query("SHOW DATABASES LIKE 'campus%'"))[0].map((r) => Object.values(r)[0]));
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\``);
  await conn.query(`USE \`${env.DB_NAME}\``);
  console.log('Tables in', env.DB_NAME + ':', (await conn.query('SHOW TABLES'))[0].map((r) => Object.values(r)[0]));
  await conn.end();
})().catch((e) => console.log('ERROR:', e.message));
