-- The registration types a new event starts with moved from a hard-coded list
-- to a per-organisation setting (Settings → General). Every organisation that
-- exists now keeps the list it had; an organisation created later starts with
-- none. Writes only Organization.settings, never an event or a registration
-- type. Idempotent: an organisation that already has the key is left alone.
-- SQL NULL and a JSON null both read as an empty object; settings that are
-- some other non-object value are left untouched rather than overwritten.
UPDATE "Organization"
SET "settings" = COALESCE(NULLIF("settings", 'null'::jsonb), '{}'::jsonb)
  || jsonb_build_object(
       'defaultRegistrationTypes',
       '["Physician", "Allied Health", "Student", "Resident", "Member"]'::jsonb
     )
WHERE ("settings" IS NULL OR jsonb_typeof("settings") IN ('object', 'null'))
  AND NOT (COALESCE(NULLIF("settings", 'null'::jsonb), '{}'::jsonb) ? 'defaultRegistrationTypes');
