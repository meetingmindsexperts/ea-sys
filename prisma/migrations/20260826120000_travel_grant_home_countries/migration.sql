-- Travel Grant: the exempt country became an organizer setting (Aug 26, 2026).
--
-- NO SCHEMA CHANGE. `Event.settings` is jsonb and the feature stores its config
-- there, so this migration only preserves BEHAVIOUR: an event that switched
-- Travel Grant on while the UAE was hard-coded meant "exempt the UAE", and the
-- reader now requires that to be said out loud. Without this line such an event
-- would read as misconfigured and quietly stop offering grants.
--
-- Yes, this writes 'AE' into a migration while the point of the change is to
-- stop hard-coding it. That is correct and not ironic: it records what those
-- events already meant. New events pick their own countries and never touch
-- this path.
--
-- Idempotent via the `? 'homeCountries'` guard — a second run matches nothing,
-- and an organizer who has since chosen different countries is never overwritten.
-- Additive and blue/green safe: the old container ignores the new key, and the
-- new container reads an event without it as "switched on but unconfigured",
-- which is disabled rather than broken.
--
-- On prod at authoring time this matched exactly ONE row ("Printing Test Event",
-- zero TravelGrant rows). It has ALREADY BEEN APPLIED there, out of band on
-- 2026-08-26: this SQL was run through `npm run prod:psql` as a syntax check, on
-- the belief that the session was read-only, and it was not (see the header of
-- scripts/prod-psql.sh). So on prod it now matches ZERO rows, which the guard
-- above makes harmless. Recorded because a future reader comparing prod against
-- the paragraph above would otherwise conclude the migration never ran.
-- On a fresh database it matches nothing.
UPDATE "Event"
SET settings = jsonb_set(settings, '{travelGrant,homeCountries}', '["AE"]'::jsonb)
WHERE settings -> 'travelGrant' ->> 'enabled' = 'true'
  AND NOT (settings -> 'travelGrant' ? 'homeCountries');
