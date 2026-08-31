/**
 * Seed catalogue for a new org's HR module: leave codes and the 2026 UAE public
 * holidays. Read from the v5.1 workbook's own "Leave Codes" sheet and its actual
 * PH rows, not invented, so the one-time import reconciles against the source it
 * came from.
 *
 * Client-safe: plain data, no `db`, so the settings UI can render the catalogue
 * without a second hand-maintained copy.
 */

import type { LeaveCategory } from "@prisma/client";

export interface LeaveCodeSeed {
  code: string;
  label: string;
  lawReference: string | null;
  paid: boolean;
  dayWeight: number;
  countsAs: LeaveCategory;
}

/**
 * `paid` answers "does the employee get money for this day", and it is coarse on
 * purpose. SL-H is half pay and is recorded here as paid, because the RATE lives
 * in `countsAs: SICK_HALF` where the tier maths can read it. Squeezing a rate
 * into a boolean is how a payroll figure ends up wrong.
 *
 * `dayWeight` is 1.0 for everything except the two explicit half-day codes.
 * Note the naming trap the module lives with, and do not "tidy" it: `-HD` means
 * half DAY, `SL-H` means half PAY. They differ by one character.
 */
export const HR_LEAVE_CODE_SEED: readonly LeaveCodeSeed[] = [
  { code: "P",     label: "Present",                    lawReference: "Normal attendance",          paid: true,  dayWeight: 1,   countsAs: "WORK" },
  { code: "OFF",   label: "Weekly Off",                 lawReference: "Company roster",             paid: true,  dayWeight: 1,   countsAs: "REST" },
  { code: "PH",    label: "Public Holiday",             lawReference: "UAE official holidays",      paid: true,  dayWeight: 1,   countsAs: "PUBLIC_HOLIDAY" },
  { code: "AL",    label: "Annual Leave",               lawReference: "Art. 29 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "ANNUAL" },
  { code: "AL-HD", label: "Annual Leave (half day)",    lawReference: "Art. 29 FDL 33/2021",        paid: true,  dayWeight: 0.5, countsAs: "ANNUAL" },
  { code: "SL-F",  label: "Sick Leave - Full Pay",      lawReference: "Art. 31 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "SICK_FULL" },
  { code: "SL-HD", label: "Sick Leave (half day)",      lawReference: "Art. 31 FDL 33/2021",        paid: true,  dayWeight: 0.5, countsAs: "SICK_FULL" },
  { code: "SL-H",  label: "Sick Leave - Half Pay",      lawReference: "Art. 31 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "SICK_HALF" },
  { code: "SL-U",  label: "Sick Leave - Unpaid",        lawReference: "Art. 31 FDL 33/2021",        paid: false, dayWeight: 1,   countsAs: "SICK_UNPAID" },
  { code: "ML",    label: "Maternity Leave",            lawReference: "Art. 30 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "MATERNITY" },
  { code: "PL",    label: "Parental Leave",             lawReference: "Art. 32 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "PARENTAL" },
  { code: "CL-S",  label: "Bereavement - Spouse",       lawReference: "Art. 32 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "BEREAVEMENT" },
  { code: "CL-F",  label: "Bereavement - Close Family", lawReference: "Art. 32 FDL 33/2021",        paid: true,  dayWeight: 1,   countsAs: "BEREAVEMENT" },
  // Cased exactly as the workbook writes it. The importer matches codes
  // case-insensitively so this cannot become a silent no-match, but the seed
  // keeps the source spelling rather than normalising it away.
  { code: "Hajj",  label: "Hajj Leave",                 lawReference: "Private sector provisions",  paid: false, dayWeight: 1,   countsAs: "HAJJ" },
  { code: "ST",    label: "Study Leave",                lawReference: "Art. 32 / as applicable",    paid: true,  dayWeight: 1,   countsAs: "STUDY" },
  { code: "NS",    label: "National Service",           lawReference: "Applicable UAE legislation", paid: true,  dayWeight: 1,   countsAs: "NATIONAL_SERVICE" },
  { code: "UL",    label: "Unpaid Leave",               lawReference: "Company policy",             paid: false, dayWeight: 1,   countsAs: "UNPAID" },
  { code: "ABS",   label: "Absent / Unauthorised",      lawReference: "Attendance record",          paid: false, dayWeight: 1,   countsAs: "ABSENT" },
  { code: "WFH",   label: "Work From Home",             lawReference: "Company policy",             paid: true,  dayWeight: 1,   countsAs: "WORK" },
  // The workbook's own note on this code reads "Two consecutive OD days earn 1
  // Comp-Off", which is what its formula does and is NOT the rule (owner ruling,
  // Aug 27 2026: only both days of the same weekend earn one). The seeded label
  // deliberately does not repeat the workbook's wording, because a description
  // that contradicts the implemented rule is worse than no description.
  //
  // And it said "weekend or holiday work" until Aug 31 2026, which was the same
  // mistake in miniature: working a public holiday earns NOTHING back, only
  // both days of one weekend do (owner ruling, reaffirmed the same day). The
  // label promised staff a day the rule never granted. It matters more now than
  // it did, because the code picker shows these labels rather than bare codes.
  { code: "OD",    label: "On Duty (weekend work)",           lawReference: "Art. 28 FDL 33/2021", paid: true, dayWeight: 1,    countsAs: "ON_DUTY" },
  { code: "CO",    label: "Comp-Off (compensatory rest day)",  lawReference: "Art. 28 FDL 33/2021", paid: true, dayWeight: 1,    countsAs: "COMP_OFF" },
];

export interface PublicHolidaySeed {
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  label: string;
}

/**
 * The 2026 UAE public holidays, taken from the PH rows the workbook actually
 * contains rather than from a published list.
 *
 * That distinction earned its keep: the first draft of the plan carried
 * "Jan 1; Mar 19-20; May 26-29; Jun 15; Aug 28; Dec 2-3", and the workbook has
 * THIRTEEN dates, not eleven. It also holds Jan 2 and May 25, so the Eid al-Adha
 * block is five days, not four. Seeding the published list would have marked two
 * real holidays as ordinary working days, and since an unrecorded day derives to
 * Present, nobody would ever have seen an error.
 *
 * Labels are best-effort where the workbook left the note blank; the DATES are
 * what the module computes from. Islamic dates move with the moon, so 2027 and
 * beyond are entered by HR and never generated.
 */
export const HR_PUBLIC_HOLIDAYS_2026: readonly PublicHolidaySeed[] = [
  { date: "2026-01-01", label: "New Year's Day" },
  { date: "2026-01-02", label: "New Year Holiday" },
  { date: "2026-03-19", label: "Eid al-Fitr" },
  { date: "2026-03-20", label: "Eid al-Fitr" },
  { date: "2026-05-25", label: "Arafat Day" },
  { date: "2026-05-26", label: "Eid al-Adha" },
  { date: "2026-05-27", label: "Eid al-Adha" },
  { date: "2026-05-28", label: "Eid al-Adha" },
  { date: "2026-05-29", label: "Eid al-Adha" },
  { date: "2026-06-15", label: "Islamic New Year" },
  { date: "2026-08-28", label: "Prophet Muhammad's Birthday" },
  { date: "2026-12-02", label: "UAE National Day" },
  { date: "2026-12-03", label: "UAE National Day" },
];

/**
 * The dates of 2027 that do NOT move: the Gregorian ones. The Islamic holidays
 * of 2027 are entered by HR on the Holidays screen once announced, exactly as
 * the header above says; seeding a guess would silently change which days are
 * working days. Seeding the fixed ones stops a rule-based AL block charging New
 * Year's Day on 1 January 2027 before anyone has opened the screen (review M8).
 */
export const HR_PUBLIC_HOLIDAYS_2027_FIXED: readonly PublicHolidaySeed[] = [
  { date: "2027-01-01", label: "New Year's Day" },
  { date: "2027-12-02", label: "UAE National Day" },
  { date: "2027-12-03", label: "UAE National Day" },
];
