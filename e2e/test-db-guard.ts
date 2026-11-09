/**
 * The e2e run drops and rebuilds its database every time, so it must only ever
 * touch the disposable one (W1-2, Nov 9, 2026).
 *
 * Refuses unless the URL names the `ea_sys_test` database on this machine, and
 * never the local production copy (port 54322, docs/LOCAL_DEV_DATABASE.md) or
 * whatever DATABASE_URL points at. The local prod copy has already been wiped
 * twice by a command aimed at the wrong database (INC-002 and the
 * shadow-database one), and both times the command looked harmless.
 */
export const E2E_DB_NAME = "ea_sys_test";
const PROD_COPY_PORT = "54322";

export function assertDisposableTestDb(url: string | undefined, appDbUrl?: string): string {
  if (!url) {
    throw new Error("DATABASE_URL_TEST is not set. Add it to .env.local (postgres://…@localhost:5432/ea_sys_test).");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL_TEST is not a valid URL.");
  }
  const db = parsed.pathname.replace(/^\//, "");
  const problems: string[] = [];
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) problems.push(`host is ${parsed.hostname}, not localhost`);
  if (db !== E2E_DB_NAME) problems.push(`database is "${db}", not "${E2E_DB_NAME}"`);
  if (parsed.port === PROD_COPY_PORT) problems.push(`port ${PROD_COPY_PORT} is the local production copy`);
  if (appDbUrl && appDbUrl === url) problems.push("it is the same URL as DATABASE_URL");
  if (problems.length > 0) {
    throw new Error(`Refusing to rebuild DATABASE_URL_TEST: ${problems.join("; ")}.`);
  }
  return url;
}
