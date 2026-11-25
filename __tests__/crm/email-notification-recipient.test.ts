/**
 * Who hears about an email arriving in the CRM inbox (owner, Nov 25, 2026): the
 * deal's owner, else the contact's, else the account's. On production 98 of the
 * first 113 emails received were on conversations with no deal, and nobody was told.
 */
import { describe, expect, it } from "vitest";
import { emailNotificationTarget, type EmailNotifyThread } from "@/crm/lib/email-notification-recipient";

const contact = (over: Partial<NonNullable<EmailNotifyThread["crmContact"]>> = {}) => ({
  firstName: "Jane",
  lastName: "Doe",
  ownerId: null,
  company: null,
  ...over,
});

describe("emailNotificationTarget", () => {
  it("tells the deal's owner when the conversation is on a deal", () => {
    expect(
      emailNotificationTarget({
        deal: { name: "Abbott - MEHFC 2027", ownerId: "u-deal" },
        crmContact: contact({ ownerId: "u-contact", company: { name: "Abbott", ownerId: "u-account" } }),
      }),
    ).toEqual({ recipientId: "u-deal", via: "deal", about: "Abbott - MEHFC 2027" });
  });

  it("falls back to the contact's owner when there is no deal, and names the account", () => {
    expect(
      emailNotificationTarget({
        deal: null,
        crmContact: contact({ ownerId: "u-contact", company: { name: "Abbott", ownerId: "u-account" } }),
      }),
    ).toEqual({ recipientId: "u-contact", via: "contact", about: "Abbott" });
  });

  it("falls back to the contact's owner when the deal has no owner, still naming the deal", () => {
    expect(
      emailNotificationTarget({ deal: { name: "Unowned deal", ownerId: null }, crmContact: contact({ ownerId: "u-contact" }) }),
    ).toEqual({ recipientId: "u-contact", via: "contact", about: "Unowned deal" });
  });

  it("falls back to the account's owner when the contact has none", () => {
    expect(
      emailNotificationTarget({ deal: null, crmContact: contact({ company: { name: "GSK", ownerId: "u-account" } }) }),
    ).toEqual({ recipientId: "u-account", via: "account", about: "GSK" });
  });

  it("names the person when there is no deal and no account", () => {
    expect(emailNotificationTarget({ deal: null, crmContact: contact({ ownerId: "u-contact" }) })).toEqual({
      recipientId: "u-contact",
      via: "contact",
      about: "Jane Doe",
    });
  });

  it("tells nobody when nothing on the conversation has an owner", () => {
    expect(emailNotificationTarget({ deal: null, crmContact: contact({ company: { name: "GSK", ownerId: null } }) })).toEqual({
      recipientId: null,
      via: null,
      about: "GSK",
    });
    expect(emailNotificationTarget({ deal: null, crmContact: null })).toEqual({
      recipientId: null,
      via: null,
      about: "a conversation",
    });
  });
});
