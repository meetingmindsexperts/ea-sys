# HCP portal, brands and addresses: plan and decision record (Nov 10, 2026)

**Status:** Stage 1 built and committed, not pushed. Stage 2 in progress (owner
answered O1 to O4 on Nov 10). Stage 3 decided for later.

**Owner, Nov 10, 2026:** "The HCP portal to manage registrations and so on should
show Meeting Minds Experts, not Meeting Minds Group. The internal tool for staff
is all Meeting Minds Group."

This file is the single place for what was decided, what is built, and the order
of what is left. Background on multi-tenancy in general is
[MULTI_TENANCY.md](MULTI_TENANCY.md); this plan sits inside its decisions and
does not change them.

---

## 1. The model in one paragraph

Three things are kept apart.

- **Tenant:** whose data it is. This is the `Organization`.
- **Audience:** who a screen is for. Staff use the tool; HCPs use the portal.
- **Brand:** what name and logo they see.

The brand is **data**, not code. Each tenant holds an attendee-facing brand in
Settings, and the request's **address** decides which tenant is meant.

Robust multi-tenant products split audiences by address too: Zendesk host-maps a
domain per brand, Shopify serves admin on `admin.shopify.com` and customer
accounts on the store's domain, and Auth0 brands its login per custom domain.
None of them split audiences by URL path on one address. Research sources are
in §7.

---

## 2. Decisions

| # | Decision | Who, when | Status |
|---|---|---|---|
| D1 | HCP-facing screens show Meeting Minds Experts; staff screens show MM Group | Owner, Nov 10 | **Decided** |
| D2 | The attendee-facing brand is set in Settings (name + logo), not a file in the repo | Owner, Nov 10 ("give that in settings") | **Decided, built** |
| D3 | The brand is chosen by the request's address (`TenantDomain`), so every platform customer gets their own for free | Engineering, Nov 10 | **Decided, built** |
| D4 | One account per person within a tenant (staff, speaker, reviewer and attendee can be the same account). Across platform tenants, accounts are tenant-scoped, as [MULTI_TENANCY.md](MULTI_TENANCY.md) §"Users" already decides | Existing decision, restated | **Decided** |
| D5 | Do not split the HCP portal into a separate application. Make it a module (`src/portal/`, one-way imports, like `src/crm/`) **later, together with Stage 3**: the address split draws the boundary, and moving ~37k lines now would churn every in-flight change for no visible gain. Bring it forward if a separate person or team owns the portal, or portal changes start breaking staff screens | Owner asked for a recommendation, Nov 10 | **Decided: later, with Stage 3** |
| D6 | **One sign-in door for now.** Before sign-in nobody is known, so the sign-in pages show the address's attendee-facing brand (Meeting Minds Experts); staff see MM Group once inside (sidebar, tab title, staff emails). The path-based `/staff/login` door was tried and removed: it needed a copy of every auth page | Owner, Nov 10 | **Decided** |
| D7 | Staff and HCPs are separated **by address later** (a portal domain for HCPs, the app domain for staff), with the old public links redirecting permanently. That is what gives staff an MM Group sign-in page | Owner, Nov 10 ("separate address as later") | **Decided: later** |
| D8 | On the platform, each customer's people are their own: same person at two customers means two separate accounts, different data, no overlap and no merge | Owner, Nov 10 (confirms MULTI_TENANCY.md §"Users") | **Decided** |

---

## 3. Where things stand

| Item | State |
|---|---|
| `a1296982` dashboard shell no longer scrolls up over a blank strip | Committed, **not pushed**. Safe to push on its own |
| `8c6bf855` attendee-facing brand (Settings field, sign-in pages, catalogue, event pages, link previews, HCP sidebar, kiosk, reset email) plus `/staff/login` | Committed, **not pushed**. Review found 0 BLOCKER, 0 HIGH, 2 MED, 8 LOW |
| Fixes for that review (staff tab titles, a settings leak in the public event API, logo restricted to uploads or https, brand cache, confirmation email footer, reset email never failing on branding) and the removal of `/staff/login` (D6) | Stage 2a, in progress |
| Staff cannot register themselves for an event or webinar | Fixed Nov 10 (Stage 2b), committed, not pushed |
| Favicon still the MM Group mark on HCP pages | Not started. Needs a square crop of the MME globe |

---

## 4. Owner answers (Nov 10, 2026)

- **O1. One sign-in door for now:** yes (D6).
- **O2. A separate HCP address:** yes, later (D7). Pick the switch date away from any live registration rush.
- **O3. Portal as a module:** later, together with Stage 3 (D5).
- **O4. Platform customers' people stay separate:** yes, no overlap and no merge (D8).

---

## 5. Order of work

### Stage 1: brand as data, chosen by address (built)

Commit `8c6bf855`.

What it built:
- `Organization.settings.publicBrand {name, logo}`, read by
  [public-brand.ts](../src/lib/public-brand.ts).
- Either half left empty falls back to the organisation's own name or logo.

What it does **not** do: nothing changes on production until someone sets the
field in Settings, Organization.

### Stage 2: finish and ship (next)

- **2a. Brand review round:**
  - Remove `/staff/login` and the `/staff/*` copies (D6), and keep every real fix.
  - Commit, review, push together with `a1296982` and `8c6bf855`.
- **2b. Staff self-registration** (Nov 10 diagnosis):
  - The event's Register link shows staff an "Organizer view" with no form.
  - The form ignores a staff sign-in on purpose (staff register other people), so it asks them to create an account. They are told "you already have an account, sign in", sign in, and land on the same step again.
  - Getting past it needs a second Continue. The registration then attaches to their account only if the password typed matches or their email is confirmed, and an unattached webinar registration cannot watch.
  - Fix: when a staff member is signed in, ask "Register myself" or "Register someone else". Add "Register myself" to the organizer view.
- **2c. Owner, on production:** Settings, Organization, Attendee-facing brand. Set the name to "Meeting Minds Experts", upload the logo, save.
- **2d. Optional:** the MME favicon for HCP pages.

### Stage 3: separate the HCP address (decided for later, D7)

**Code:**
1. `TenantDomain.audience` (`STAFF` | `PUBLIC`): one organisation, several addresses, a meaning per address. Additive migration.
2. The brand and the sign-in frame read the address's audience; no role branching for branding.
3. HCP-facing pages are canonical on the PUBLIC address: `/e/*`, `/catalogue`, `/signup`, `/login`, `/my-account`, `/my-reviews`.
4. On the STAFF address those paths redirect permanently (301) to the same path and query, so old links, sent emails and tokens keep working.
5. Emails to HCPs build links on the PUBLIC address. Today one `NEXT_PUBLIC_APP_URL` builds every link.
6. Move the organizer "form links" view into the dashboard; on the portal address staff are not signed in as staff. This also ends the self-registration trap without special code.
7. Stripe checkout return addresses use the PUBLIC address. Webhooks are unaffected.

**Owner (instruct, not executed):**
- DNS for the portal address.
- A certificate covering it.
- An nginx server block for it.
- A `TenantDomain` row (audience PUBLIC) added with the existing script.

**Switch day:**
- Away from any live event's registration rush.
- Verify the redirects, an event registration, a sign-in, a webinar join and a certificate link on the new address.

**Attendee impact:** one extra sign-in per device; same accounts and passwords.

### Stage 4: later

- **Portal module boundary (D5):** with Stage 3.
- **Platform custom domains per customer:** [MULTI_TENANCY.md](MULTI_TENANCY.md) §3.3 covers this (Caddy on-demand TLS). Stage 3's audience field is what lets one customer have a staff address and a public address.

---

## 6. How to tell this design from a workaround

Use these four checks on any future change here:

1. **Growth.** Does the next new page need special handling?
2. **Where the decision lives.** Is it made once, at the address, or in pages, links and redirects?
3. **Data or code.** Can an admin change it in Settings, or does it need a deploy?
4. **Tenant two.** Would a second customer get it right with no new code?

The `/staff/*` doors fail checks 1 and 2. Brand-by-address passes all four.

---

## 7. Research sources (Nov 10, 2026)

- [Zendesk: Setting up multiple brands](https://support.zendesk.com/hc/en-us/articles/4408829476378-Setting-up-multiple-brands)
- [Zendesk brand host mapping](https://www.eesel.ai/blog/zendesk-brand-host-mapping)
- [Shopify: Connect a domain for new customer account pages](https://help.Shopify.com/en/manual/domains/add-a-domain/connecting-domains/connect-domain-customer-account)
- [Shopify: Setting up new customer accounts](https://help.shopify.com/en/manual/customers/customer-accounts/customer-login)
- [Cvent: Custom URL or private domain](https://support.cvent.com/articles/en_US/Knowledge/Setting-Up-Your-Custom-URL-or-Private-Domain)
- [Auth0: Multi-brand branding per custom domain](https://support.auth0.com/center/s/article/implement-multi-brand-branding-per-custom-domain-in-auth0)
- [Auth0: Multiple custom domains](https://auth0.com/blog/unlimited-brand-experiences-auth0-multiple-custom-domains/)
- [Clerk: Multi-tenant architecture](https://clerk.com/docs/guides/multi-tenant-architecture)
- [WorkOS: Modeling your app](https://workos.com/docs/authkit/modeling-your-app.md)
