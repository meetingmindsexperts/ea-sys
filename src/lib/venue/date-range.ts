/**
 * An event's dates as the venue's signs show them, in the event's timezone:
 * "4 September 2026", "10 to 12 April 2026", "30 March to 2 April 2026",
 * "30 December 2026 to 2 January 2027".
 */
export function venueDateRange(start: Date, end: Date, timeZone: string): string {
  const parts = (d: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", year: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]),
    );
    return { d: p.day, m: p.month, y: p.year };
  };
  const a = parts(start);
  const b = parts(end);
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} to ${b.d} ${b.m} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${a.m} to ${b.d} ${b.m} ${b.y}`;
  if (a.d !== b.d) return `${a.d} to ${b.d} ${b.m} ${b.y}`;
  return `${a.d} ${a.m} ${a.y}`;
}
