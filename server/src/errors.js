/**
 * An error the API answers with `{"error": message, "code": code}`. The app
 * is in Persian and shows its own text per `code`; `message` is for logs and
 * for whoever reads the API by hand.
 */
export function httpError(status, code, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.code = code;
  return err;
}
