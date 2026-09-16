/**
 * THE PERMISSION CATALOGUE: every capability a custom role can grant.
 *
 * Plan of record: docs/PROCUREMENT_ROLES_PLAN.md. A custom role ("PO Author")
 * is a named set of these keys, tagged onto a person on top of their base role
 * (D1, D2). One person may hold several; their capability is the UNION.
 *
 * WHY THE CATALOGUE LIVES IN CODE AND NOT IN A TABLE. A key is only meaningful
 * because a route asks for it, so the set of valid keys is a property of the
 * deployed build, not of the data. Holding them in a table would let a row name
 * a permission nothing enforces, which reads as access and grants none. The
 * join table stores keys and is validated against this file on write.
 *
 * WHY IT LIVES IN CORE AND NOT IN `src/procurement/`. Settings, the sidebar and
 * the dashboard layout all need it, and each would otherwise be an exemption on
 * the one-way import boundary: the same reasoning that placed
 * `procurement-visibility.ts` and `module-flags.ts` here. Client-safe by
 * construction: no db, no Node imports, no `next/server`.
 *
 * NAMESPACED (`procurement.*`) because D5 reuses these three tables for CRM and
 * HR. A future module adds its own block; nothing here changes.
 */

/** Every capability a custom role can grant today. Order is display order. */
export const PERMISSION_KEYS = [
  // Budgets
  "procurement.budgets.view",
  "procurement.budgets.create",
  "procurement.budgets.edit",
  "procurement.budgets.discard",
  "procurement.budgets.signoff",
  // Approvals
  "procurement.approvals.decide",
  // Spend requests
  "procurement.requests.view",
  "procurement.requests.create",
  "procurement.requests.manage",
  // Purchase orders
  "procurement.orders.view",
  "procurement.orders.receive",
  "procurement.orders.cancel",
  "procurement.orders.confirmReceipt",
  "procurement.orders.send",
  // Suppliers
  "procurement.suppliers.view",
  "procurement.suppliers.propose",
  "procurement.suppliers.decide",
  "procurement.suppliers.edit",
  "procurement.suppliers.financials.view",
  // Catalogue
  "procurement.catalogue.manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/** Is this string a permission this build actually enforces? Fails closed. */
export function isPermissionKey(key: string): key is PermissionKey {
  return PERMISSION_KEY_SET.has(key);
}

/** Groups for the role editor, in display order. */
export const PERMISSION_GROUPS = [
  "Budgets",
  "Approvals",
  "Requests",
  "Orders",
  "Suppliers",
  "Catalogue",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionDescriptor {
  key: PermissionKey;
  group: PermissionGroup;
  /** The checkbox label. Plain words: the reader is an administrator, not a developer. */
  label: string;
  /** One sentence under the label saying what it actually lets the person do. */
  description: string;
}

/**
 * The catalogue itself. Every key above appears exactly once; a drift test
 * asserts both directions, because a key with no descriptor renders as a blank
 * checkbox and a descriptor with no key grants nothing.
 *
 * DELIBERATELY ABSENT: `budgets.reopen`. Owner decision D15 puts reopening a
 * closed budget and unfreezing a frozen one WITH budget authoring, so those
 * routes ask for `budgets.edit`. A separate key that is always ticked beside
 * another one is a key nobody can use differently.
 */
export const PERMISSION_CATALOGUE: readonly PermissionDescriptor[] = [
  {
    key: "procurement.budgets.view",
    group: "Budgets",
    label: "See the Budgets list",
    description: "Open the Budgets screen and read any budget for the organisation.",
  },
  {
    key: "procurement.budgets.create",
    group: "Budgets",
    label: "Create budgets",
    description: "Start a new budget for an event, from scratch or from a template.",
  },
  {
    key: "procurement.budgets.edit",
    group: "Budgets",
    label: "Edit and submit budgets",
    description:
      "Change lines, submit for approval, reallocate, start a new version, freeze, close, and reopen or unfreeze a closed one.",
  },
  {
    key: "procurement.budgets.discard",
    group: "Budgets",
    label: "Discard a draft budget",
    description: "Throw away a budget that was never approved. Approved budgets are never deleted.",
  },
  {
    key: "procurement.budgets.signoff",
    group: "Budgets",
    label: "Sign off a closed budget",
    description: "The finance sign-off that ends a budget after close-out.",
  },
  {
    key: "procurement.approvals.decide",
    group: "Approvals",
    label: "Approve or reject",
    description:
      "Decide budgets, reallocations and spend requests, up to the AED limit set on this person.",
  },
  {
    key: "procurement.requests.view",
    group: "Requests",
    label: "See spend requests",
    description: "Read the organisation's purchase requests.",
  },
  {
    key: "procurement.requests.create",
    group: "Requests",
    label: "Raise spend requests",
    description:
      "Raise a purchase request, attach quotes, submit it, and amend your own. Includes seeing the budget line you are spending against.",
  },
  {
    key: "procurement.requests.manage",
    group: "Requests",
    label: "Edit or cancel anyone's request",
    description: "Act on a request somebody else raised.",
  },
  {
    key: "procurement.orders.view",
    group: "Orders",
    label: "See purchase orders",
    description: "Read the orders issued against approved requests.",
  },
  {
    key: "procurement.orders.receive",
    group: "Orders",
    label: "Mark goods received",
    description: "Record a partial or full receipt against an order you raised.",
  },
  {
    key: "procurement.orders.cancel",
    group: "Orders",
    label: "Cancel an order",
    description: "Close an order and release what it had committed on the budget line.",
  },
  {
    key: "procurement.orders.confirmReceipt",
    group: "Orders",
    label: "Confirm a large receipt",
    description:
      "The second pair of eyes on a full receipt of AED 50,000 or more. Never the person who received it.",
  },
  {
    key: "procurement.orders.send",
    group: "Orders",
    label: "Send an order to the supplier",
    description: "Email the purchase order PDF to the supplier's contacts.",
  },
  {
    key: "procurement.suppliers.view",
    group: "Suppliers",
    label: "See suppliers",
    description: "Read the supplier master, without tax numbers or bank details.",
  },
  {
    key: "procurement.suppliers.propose",
    group: "Suppliers",
    label: "Propose a supplier",
    description: "Put a new supplier forward for approval.",
  },
  {
    key: "procurement.suppliers.decide",
    group: "Suppliers",
    label: "Approve or reject suppliers",
    description: "Decide a proposed supplier and let its waiting requests convert to orders.",
  },
  {
    key: "procurement.suppliers.edit",
    group: "Suppliers",
    label: "Edit suppliers",
    description: "Change an approved supplier's details, including bank details.",
  },
  {
    key: "procurement.suppliers.financials.view",
    group: "Suppliers",
    label: "See supplier tax and bank details",
    description: "Read the classified fields on a supplier record.",
  },
  {
    key: "procurement.catalogue.manage",
    group: "Catalogue",
    label: "Manage the catalogue",
    description: "Add and edit products, budget templates and cost categories.",
  },
];

/**
 * The starter roles seeded once per organisation (D11, narrowed by D14 to these
 * four: no Project Manager role and no Budget Viewer). Editable and archivable
 * afterwards, so this is a starting point rather than a fixed list.
 *
 * PO AUTHOR IS THE PROJECT-MANAGER ROLE (D14). Every project manager is a
 * MEMBER, and a MEMBER authors nothing by role, so this set is what a PM needs:
 * budget authoring plus raising requests and receiving what they ordered.
 *
 * THE TWO SEPARATION RULES ARE BUILT INTO THESE SETS and re-checked on the
 * union when roles are assigned (§4): the approver never holds
 * `requests.create`, and the settle holder never holds `approvals.decide`.
 */
export interface StarterRole {
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

export const STARTER_ROLES: readonly StarterRole[] = [
  {
    name: "PO Author",
    description:
      "Runs an event's budget and buys against it: creates and edits the budget, raises purchase requests, receives what arrives. Held by project managers.",
    permissions: [
      "procurement.budgets.view",
      "procurement.budgets.create",
      "procurement.budgets.edit",
      "procurement.budgets.discard",
      "procurement.requests.view",
      "procurement.requests.create",
      "procurement.orders.view",
      "procurement.orders.receive",
      "procurement.suppliers.view",
      "procurement.suppliers.propose",
    ],
  },
  {
    name: "PO Approver",
    description:
      "Decides budgets and spend requests up to the AED limit set on the person. Deliberately cannot raise a request, so a request never reaches its own author.",
    permissions: [
      "procurement.budgets.view",
      "procurement.requests.view",
      "procurement.approvals.decide",
      "procurement.orders.view",
      "procurement.suppliers.view",
    ],
  },
  {
    name: "Requester",
    description:
      "Raises purchase requests and receives what arrives, without reaching the Budgets screen. Sees the line being spent against, and nothing more of the budget.",
    permissions: [
      "procurement.requests.view",
      "procurement.requests.create",
      "procurement.orders.view",
      "procurement.orders.receive",
      "procurement.suppliers.view",
      "procurement.suppliers.propose",
    ],
  },
  {
    name: "Finance Settle",
    description:
      "Checks completeness and settles: signs off closed budgets, manages suppliers and their bank details, sends and cancels orders. Never decides an approval.",
    permissions: [
      "procurement.budgets.view",
      "procurement.budgets.signoff",
      "procurement.requests.view",
      "procurement.requests.manage",
      "procurement.orders.view",
      "procurement.orders.cancel",
      "procurement.orders.confirmReceipt",
      "procurement.orders.send",
      "procurement.suppliers.view",
      "procurement.suppliers.decide",
      "procurement.suppliers.edit",
      "procurement.suppliers.financials.view",
    ],
  },
];
