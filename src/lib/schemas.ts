import { z } from "zod";

/** Shared Zod enum for Title field — matches Prisma Title enum */
export const titleEnum = z.enum(["MR", "MS", "MRS", "DR", "PROF", "OTHER"]);
