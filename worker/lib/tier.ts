/**
 * Marks this process as the WORKER tier, for the `tier` field every log line
 * carries (src/lib/logger.ts).
 *
 * WHY IT IS A SIDE-EFFECT MODULE AND NOT A LINE IN worker/index.ts. ES module
 * imports are hoisted and evaluated before any statement in the importing
 * file's body, so `process.env.EA_SYS_TIER = "worker"` written at the top of
 * `worker/index.ts` would still run AFTER the logger module had been evaluated
 * and had already read the variable into pino's base fields. Importing this
 * first is the only ordering that works, and it is the same technique the
 * Sentry config beside it uses.
 *
 * `??=` so an explicit env value (a compose file, a one-off script) always
 * wins over this default.
 */
process.env.EA_SYS_TIER ??= "worker";
