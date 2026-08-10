/**
 * The CRM's client-safe enum tuples vs the real Prisma enums.
 *
 * WHY THIS FILE EXISTS. `crm-types.ts` is imported by `"use client"` components,
 * so it cannot import `@prisma/client` — the tuples there are hand-written, and
 * a hand-written copy of a database enum drifts the moment someone adds a value.
 *
 * It also exists because a comment in `freshsales-import.ts` asserted *"A drift
 * test pins them against the real enums"* when no such test had been written.
 * A stated guarantee nobody grepped for is worse than no guarantee: it stops the
 * next reader checking. This is that test, for real.
 *
 * A test file is server-side, so importing the Prisma enums here is fine.
 */
import { describe, it, expect } from "vitest";
import { CrmContactStatus, CrmLifecycleStage } from "@prisma/client";
import { CONTACT_STATUS_VALUES, LIFECYCLE_VALUES } from "@/crm/lib/crm-types";
import {
  CRM_CONTACT_STATUS_VALUES,
  CRM_LIFECYCLE_VALUES,
} from "@/crm/lib/freshsales-import";

describe("CRM enum tuples match the database", () => {
  it("CONTACT_STATUS_VALUES covers CrmContactStatus exactly, in both directions", () => {
    // Both directions on purpose: a MISSING value silently drops every CSV row
    // carrying it (the importer reports it as "no matching value in EA-SYS"),
    // while an EXTRA value renders a dropdown option Postgres will reject on save.
    expect([...CONTACT_STATUS_VALUES].sort()).toEqual(Object.values(CrmContactStatus).sort());
  });

  it("LIFECYCLE_VALUES covers CrmLifecycleStage exactly, in both directions", () => {
    expect([...LIFECYCLE_VALUES].sort()).toEqual(Object.values(CrmLifecycleStage).sort());
  });

  it("the importer uses those exact tuples rather than its own copy", () => {
    // It used to declare its own, so a value added to the dropdown would still
    // have imported as null. Identity, not equality — a re-declared copy that
    // happened to match today would pass a deep-equal check and drift tomorrow.
    expect(CRM_CONTACT_STATUS_VALUES).toBe(CONTACT_STATUS_VALUES);
    expect(CRM_LIFECYCLE_VALUES).toBe(LIFECYCLE_VALUES);
  });
});
