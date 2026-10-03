import pg from 'pg';

// BIGINT ids and Telegram ids fit comfortably in a double; read them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(db) {
  return new pg.Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: db.ssl ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}
