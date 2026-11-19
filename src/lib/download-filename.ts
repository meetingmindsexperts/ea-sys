/**
 * The Content-Disposition value for a download whose name is built from text
 * a person typed: an event's slug or code (Nov 12, 2026).
 *
 * A header value may hold Latin-1 only. Anything else makes `new Response`
 * throw a TypeError, so the handler answers 500 after doing all its work: the
 * certificate recipients CSV did, for the one event whose slug holds a Greek
 * letter ("AβTC2026"). Neither the slug nor the code is limited to plain
 * letters when an organiser types it.
 *
 * Two names, as RFC 6266 has it: a plain `filename` every browser reads, with
 * each other character replaced by "_", and `filename*` carrying the real
 * name for the browsers that read it (all current ones, which then prefer it).
 * A page that reads the name out of the header with /filename="([^"]+)"/ still
 * finds the plain one.
 */
export function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  const plain = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * alone; RFC 5987 does not allow them bare.
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * A name cut to `max` characters with its extension kept (Nov 19, 2026): a
 * plain cut dropped the ".pdf" from a long name, so the downloaded file did
 * not open on a double click. Cut by character, never by UTF-16 unit: half an
 * emoji makes `encodeURIComponent` throw.
 */
export function truncateFilename(name: string, max = 120): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? Array.from(name.slice(dot)) : [];
  // An "extension" longer than 10 characters is part of the name, not a type.
  if (ext.length === 0 || ext.length > 10) return chars.slice(0, max).join("");
  return chars.slice(0, max - ext.length).join("") + ext.join("");
}
