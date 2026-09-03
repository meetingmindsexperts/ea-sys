/**
 * RE-EXPORT ONLY. The predicate moved to `src/lib/hr-visibility.ts` on
 * Sep 3, 2026, because core needed it in more than one place (the sidebar, and
 * the org Activity page's HR tab) and each place was costing an eslint
 * exemption on the one-way import boundary. The rationale for the move is in
 * the file's own header.
 *
 * This shim exists so nothing inside `src/hr/` had to change its import, and
 * so the module keeps one obvious place to look for "who may see HR". Import
 * from here inside the module; import from `@/lib/hr-visibility` in core.
 */
export {
  HR_SELF_SUFFICIENT_ROLES,
  HR_AUDIT_ENTITY_TYPES,
  canViewHr,
  canWriteHr,
  isHrAuditEntityType,
} from "@/lib/hr-visibility";
export type { HrAuditEntityType } from "@/lib/hr-visibility";
