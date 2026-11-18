/**
 * Where `npm run e2e:rls` runs. Constants on purpose, never read from the
 * environment: the run drops and rebuilds its database, so its address must
 * not be something a stray variable can change. localhost:55432 is the tenancy
 * harness's Postgres (docker compose --profile tenancy), which holds only
 * disposable databases and is where the non-owner role `app_user` exists.
 */
export const RLS_DB_NAME = "ea_sys_test";
export const RLS_SERVER_URL = "postgresql://postgres:postgres@localhost:55432";
/** The owner: migrations, seed, policies, and the app's privileged lane. */
export const RLS_OWNER_URL = `${RLS_SERVER_URL}/${RLS_DB_NAME}`;
/** What the app connects as: a role that policies apply to. */
export const RLS_APP_URL = `postgresql://app_user:app_user_pw@localhost:55432/${RLS_DB_NAME}`;
export const RLS_PORT = "3123";
/** The test server's output, read by server-log.spec.ts. Under /logs, which git ignores. */
export const RLS_SERVER_LOG = "logs/e2e-rls-server.log";
