-- The registration types a new event starts with moved from a hard-coded list
-- to a per-organisation setting (Settings → General). Every organisation that
-- exists now keeps the list it had; an organisation created later starts with
-- none. Writes only Organization.settings, never an event or a registration
-- type. Idempotent: an organisation that already has the key is left alone.
UPDATE "Organization"
SET "settings" = COALESCE("settings", '{}'::jsonb)
  || jsonb_build_object(
       'defaultRegistrationTypes',
       '["Physician", "Allied Health", "Student", "Resident", "Member"]'::jsonb
     )
WHERE NOT (COALESCE("settings", '{}'::jsonb) ? 'defaultRegistrationTypes');
