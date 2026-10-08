import vm from "node:vm";

/**
 * The AI attendees' fixed lists (phase 5): names, titles, places, cities,
 * traits, interests, rooms, and the staff and stand roles. The server checks
 * every persona the page sends against these, so nothing free-form reaches the
 * AI's instructions. Read from the vendor's own source so they cannot drift:
 * social.js opens with data-only constants (evaluated in an empty sandbox), and
 * makePersona's fixed roles are `title = '…'; org = '…'; kind = '…'`.
 */
export function extractVocab(socialSrc, worldSrc) {
  const head = socialSrc.slice(0, socialSrc.indexOf("const hashStr"));
  const lists = vm.runInNewContext(`${head};({ PEOPLE_NAMES, DELEGATE_TITLES, CITIES, PLACES, TRAITS, INTERESTS, ZONE_NAMES })`, {}, { timeout: 1000 });
  const body = socialSrc.slice(socialSrc.indexOf("function makePersona"), socialSrc.indexOf("class Social"));
  const roles = [...body.matchAll(/title = '([^']+)'; org = '([^']+)'; kind = '([a-z]+)'/g)].map((m) => ({ title: m[1], org: m[2], kind: m[3] }));
  const organiser = /organiser: '([^']+)'/.exec(worldSrc)?.[1];
  if (!roles.length || !organiser || !lists.PEOPLE_NAMES?.f?.length) throw new Error("venue vocab: the vendor source changed shape; update extractVocab");
  return { generatedBy: "scripts/venue-build.mjs", source: "vendor/ehc-venue/src/social.js", ...JSON.parse(JSON.stringify(lists)), ROLES: roles, ORGANISER: organiser };
}
