/** The toast after an issued order's automatic email did not end as sent (review L2, Oct 28, 2026). */
import { describe, it, expect } from "vitest";
import { autoSendWarning } from "@/procurement/hooks/use-procurement-api";

describe("autoSendWarning", () => {
  it("says an email that went but was not recorded must not be sent again", () => {
    const text = autoSendWarning({ code: "SENT_NOT_RECORDED" }, "Purchase order PO-1 issued");
    expect(text).toContain("It was emailed to the supplier");
    expect(text).toContain("do not send it again");
    expect(text).not.toContain("Use Send");
  });
  it("points at Send when the email did not go", () => {
    expect(autoSendWarning({ code: "SEND_FAILED" }, "Purchase order PO-1 issued")).toBe("Purchase order PO-1 issued, but the email to the supplier did not go. Use Send on the order.");
  });
});
