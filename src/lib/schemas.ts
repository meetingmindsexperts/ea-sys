import { z } from "zod";

/** Shared Zod enum for Title field — matches Prisma Title enum.
 *  Accepts empty string and transforms to undefined (for clearing). */
export const titleEnum = z.enum(["DR", "MR", "MRS", "MS", "PROF"]).or(z.literal("").transform(() => undefined));

/** Shared Zod enum for AttendeeRole field — matches Prisma AttendeeRole enum */
export const attendeeRoleEnum = z.enum([
  "ACADEMIA",
  "ALLIED_HEALTH",
  "MEDICAL_DEVICES",
  "PHARMA",
  "PHYSICIAN",
  "RESIDENT",
  "SPEAKER",
  "STUDENT",
  "OTHERS",
]);
