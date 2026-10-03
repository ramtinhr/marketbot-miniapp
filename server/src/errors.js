/**
 * An error the API answers with `{"error": message, "code": code, ...extra}`.
 * The app is in Persian and shows its own text per `code`; `message` is for
 * logs and for whoever reads the API by hand. `extra` carries the figures the
 * app shows with it, such as `retry_after`.
 */
export function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.statusCode = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

const MISSING_TABLES = new Set(['42P01', '3F000']); // undefined_table, invalid_schema_name
const UNDEFINED_COLUMN = '42703';

/**
 * A Postgres error from the exchange's schema as what it means: the engine has
 * not created it yet, or not migrated it to the version this app reads.
 */
export function exchangeDbError(err) {
  if (MISSING_TABLES.has(err.code)) {
    return httpError(503, 'exchange_unavailable', 'the exchange tables do not exist yet - start marketbot-engine with EXCHANGE_ENABLED=true');
  }
  if (err.code === UNDEFINED_COLUMN) {
    return httpError(503, 'exchange_unavailable', `the exchange schema is out of date (${err.message}) - start marketbot-engine once to migrate it`);
  }
  return err;
}
