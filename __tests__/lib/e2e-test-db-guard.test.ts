/**
 * The guard in front of the e2e run's DROP DATABASE (W1-2, Nov 9, 2026). The
 * local production copy has been wiped twice by commands aimed at the wrong
 * database, so every way of pointing this at something else must be refused.
 */
import { describe, it, expect } from "vitest";
import { assertDisposableTestDb } from "../../e2e/test-db-guard";

const OK = "postgresql://postgres:postgres@localhost:5432/ea_sys_test";

describe("assertDisposableTestDb", () => {
  it("accepts ea_sys_test on localhost, with or without query options", () => {
    expect(assertDisposableTestDb(OK)).toBe(OK);
    expect(assertDisposableTestDb("postgres://u:p@127.0.0.1:5432/ea_sys_test?schema=public")).toContain("ea_sys_test");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["not a URL", "ea_sys_test"],
    ["the local production copy's port", "postgresql://u:p@localhost:54322/ea_sys_test"],
    ["another database name", "postgresql://u:p@localhost:5432/ea_sys_prod_local"],
    ["an uppercase name", "postgresql://u:p@localhost:5432/EA_SYS_TEST"],
    ["a remote host", "postgresql://u:p@db.example.com:5432/ea_sys_test"],
    ["a ?host= socket override", "postgresql://u:p@localhost:5432/ea_sys_test?host=/var/run/postgresql"],
    ["a ?hostaddr= override", "postgresql://u:p@localhost:5432/ea_sys_test?hostaddr=10.0.0.5"],
    ["a ?port= override", "postgresql://u:p@localhost:5432/ea_sys_test?port=54322"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertDisposableTestDb(url)).toThrow();
  });

  it("refuses the URL the app itself runs on, whatever it is called", () => {
    expect(() => assertDisposableTestDb(OK, OK)).toThrow(/same URL as DATABASE_URL/);
  });
});
