-- Dubai (DET/DTCM) compliance flag on Event.
--
-- DTCM barcodes are a Dubai tourism requirement and apply ONLY to
-- Dubai-based events — never to Abu Dhabi / Fujairah / Al Ain or non-UAE
-- events (Oman, Kuwait, Qatar, ...). The platform had no way to know an
-- event was Dubai-based (only free-text city/country), so DTCM was modelled
-- as a generic optional barcode. This explicit per-event toggle lets the
-- organizer mark Dubai events; it gates VISIBILITY of the separate DTCM
-- barcode field and does not change the entry barcode (always qrCode).
--
-- Purely additive: defaults to false, so every existing event keeps today's
-- behaviour (DTCM field hidden) until an organizer opts in. Blue-green safe.
ALTER TABLE "Event"
  ADD COLUMN "requiresDtcmBarcode" BOOLEAN NOT NULL DEFAULT false;
