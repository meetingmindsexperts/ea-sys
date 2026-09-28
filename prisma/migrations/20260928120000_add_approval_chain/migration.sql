-- The spend-request approval chain (Sep 28, 2026): named people in order,
-- stored on the organisation's SPEND_REQUEST workflow definition. Additive,
-- nullable, idempotent; a null chain keeps today's ceiling routing.
ALTER TABLE "ApprovalWorkflowDefinition" ADD COLUMN IF NOT EXISTS "chain" JSONB;
