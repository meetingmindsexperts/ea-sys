/**
 * touchRegistrationsOfAttendees moves Registration.updatedAt after an
 * attendee-only write (tags, self-edit), so a staff screen opened earlier is
 * refused STALE_WRITE instead of reverting it (Oct 29, 2026).
 */
import { describe, it, expect, vi } from "vitest";
import { touchRegistrationsOfAttendees } from "@/lib/registration-touch";

describe("touchRegistrationsOfAttendees", () => {
  it("touches every registration on the given attendees, once per attendee", async () => {
    const updateMany = vi.fn(async () => ({ count: 3 }));
    await touchRegistrationsOfAttendees({ registration: { updateMany } } as never, ["a1", "a2", "a1"]);
    expect(updateMany).toHaveBeenCalledWith({ where: { attendeeId: { in: ["a1", "a2"] } }, data: { updatedAt: expect.any(Date) } });
  });

  it("does nothing for no attendees (never an unfiltered update)", async () => {
    const updateMany = vi.fn();
    await touchRegistrationsOfAttendees({ registration: { updateMany } } as never, []);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
