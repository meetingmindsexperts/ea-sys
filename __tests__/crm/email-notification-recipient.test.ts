/**
 * Who hears about an email arriving in the CRM inbox (owner, Nov 25, 2026): the
 * deal's owner, else the contact's, else the account's, each only if they may see
 * the inbox (the worker checks; this file is the order). On production 98 of the
 * first 113 emails received were on conversations with no deal, and nobody was told.
 */
import { describe, expect, it } from "vitest";
import { emailNotificationCandidates, type EmailNotifyThread } from "@/crm/lib/email-notification-recipient";

const contact = (over: Partial<NonNullable<EmailNotifyThread["crmContact"]>> = {}) => ({
  firstName: "Jane",
  lastName: "Doe",
  ownerId: null,
  company: null,
  ...over,
});

describe("emailNotificationCandidates", () => {
  it("orders the owners: deal, then contact, then account, and names the deal", () => {
    expect(
      emailNotificationCandidates({
        deal: { name: "Abbott - MEHFC 2027", ownerId: "u-deal" },
        crmContact: contact({ ownerId: "u-contact", company: { name: "Abbott", ownerId: "u-account" } }),
      }),
    ).toEqual({
      candidates: [
        { userId: "u-deal", via: "deal" },
        { userId: "u-contact", via: "contact" },
        { userId: "u-account", via: "account" },
      ],
      about: "Abbott - MEHFC 2027",
    });
  });

  it("starts at the contact's owner when there is no deal, and names the account", () => {
    expect(
      emailNotificationCandidates({
        deal: null,
        crmContact: contact({ ownerId: "u-contact", company: { name: "Abbott", ownerId: "u-account" } }),
      }),
    ).toEqual({
      candidates: [
        { userId: "u-contact", via: "contact" },
        { userId: "u-account", via: "account" },
      ],
      about: "Abbott",
    });
  });

  it("starts at the contact's owner when the deal has no owner, still naming the deal", () => {
    expect(
      emailNotificationCandidates({ deal: { name: "Unowned deal", ownerId: null }, crmContact: contact({ ownerId: "u-contact" }) }),
    ).toEqual({ candidates: [{ userId: "u-contact", via: "contact" }], about: "Unowned deal" });
  });

  it("lists one person once, at their first step", () => {
    expect(
      emailNotificationCandidates({
        deal: { name: "D", ownerId: "u-1" },
        crmContact: contact({ ownerId: "u-1", company: { name: "GSK", ownerId: "u-1" } }),
      }).candidates,
    ).toEqual([{ userId: "u-1", via: "deal" }]);
  });

  it("drops the account step when asked (a contact made just now from an unverified sender)", () => {
    expect(
      emailNotificationCandidates(
        { deal: null, crmContact: contact({ company: { name: "Abbott", ownerId: "u-account" } }) },
        { skipAccount: true },
      ),
    ).toEqual({ candidates: [], about: "Abbott" });
  });

  it("names the person when there is no deal and no account", () => {
    expect(emailNotificationCandidates({ deal: null, crmContact: contact({ ownerId: "u-contact" }) }).about).toBe("Jane Doe");
  });

  it("has nobody to try when nothing on the conversation has an owner", () => {
    expect(emailNotificationCandidates({ deal: null, crmContact: contact({ company: { name: "GSK", ownerId: null } }) })).toEqual({
      candidates: [],
      about: "GSK",
    });
    expect(emailNotificationCandidates({ deal: null, crmContact: null })).toEqual({ candidates: [], about: "a conversation" });
  });
});
