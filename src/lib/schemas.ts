import { z } from "zod";

/** Shared Zod enum for Title field — matches Prisma Title enum */
export const titleEnum = z.enum(["MR", "MS", "MRS", "DR", "PROF"]);

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
