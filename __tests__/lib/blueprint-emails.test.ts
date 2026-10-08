/** The Blueprint notification emails: wording per kind, every value escaped. */
import { describe, it, expect } from "vitest";
import { buildBlueprintEmail } from "@/lib/blueprint/blueprint-emails";

const base = { recipientName: "Ada", title: "Heart <Summit>", ref: "EB-261008-K3P", actorName: "Wren Writer", link: "https://x.test/blueprint" };

describe("buildBlueprintEmail", () => {
  it("submitted: names the sender, readiness and open items, escapes the title", () => {
    const m = buildBlueprintEmail({ ...base, kind: "submitted", readiness: 72, openCount: 3 });
    expect(m.subject).toBe("Blueprint submitted: Heart <Summit>");
    expect(m.html).toContain("Heart &lt;Summit&gt; (EB-261008-K3P)");
    expect(m.html).not.toContain("<Summit>");
    expect(m.text).toContain("Readiness 72%, 3 needed items still open.");
  });

  it("stage: tells the writer where it moved", () => {
    const m = buildBlueprintEmail({ ...base, kind: "stage", stageLabel: "In review" });
    expect(m.subject).toBe("Blueprint in review: Heart <Summit>");
    expect(m.text).toContain('Wren Writer moved your blueprint to "In review".');
    expect(m.text).toContain("Open the Event Blueprint: https://x.test/blueprint");
  });
});
