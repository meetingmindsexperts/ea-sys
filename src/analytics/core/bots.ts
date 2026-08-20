/**
 * Bot detection.
 *
 * CLIENT-SAFE. No node: imports.
 *
 * Deliberately coarse, and biased towards calling things bots. On a traffic
 * chart an over-counted bot is a rounding error; a crawler counted as a person
 * is a number somebody plans around. When in doubt, exclude.
 *
 * This is a treadmill and will never be complete. It is a maintenance item, not
 * a solved problem, and saying so here is more useful than pretending the list
 * is exhaustive.
 *
 * The beacon is JavaScript, so simple crawlers never execute it and most of the
 * problem is solved for free. What remains is headless browsers, link-preview
 * fetchers and monitoring, which do run JS or forge a browser user agent.
 */

/**
 * Anything containing "bot", "crawler" or "spider" plus the common tools and
 * monitoring agents.
 */
const OBVIOUS =
  /bot|crawler|spider|slurp|scrape|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|headless|phantom|puppeteer|playwright|selenium|monitoring|uptime|pingdom|statuscake|health-check|route53|newrelic|datadog|zabbix|nagios|censys|masscan|zgrab|expanse|shodan/;

/**
 * Link-preview fetchers, which are NOT caught above because most of them do not
 * contain the string "bot".
 *
 * These matter more here than on a typical site. Event links circulate in
 * WhatsApp groups and on Facebook, and every share triggers a preview fetch
 * that would otherwise be counted as a visit to a registration page. On the
 * production nginx logs, facebookexternalhit alone had already landed 45 hits
 * on /e/ pages in a fortnight.
 *
 * Slackbot, LinkedInBot, Twitterbot, TelegramBot and Discordbot are already
 * caught by "bot"; these are the ones that are not.
 */
const PREVIEW_FETCHERS =
  /facebookexternalhit|whatsapp|skypeuripreview|embedly|vkshare|outbrain|viber|snapchat|iframely|linkpreview|opengraph|metainspector|w3c_validator|quora link|nuzzel|bitlybot|flipboard/;

/**
 * True when this user agent should not be counted as a person.
 *
 * An absent or empty user agent counts as a bot. Every real browser sends one,
 * so its absence means a script, and treating "unknown" as human is the wrong
 * default for a number people plan around.
 */
export function isBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  const ua = userAgent.trim().toLowerCase();
  if (ua === "" || ua === "-") return true;
  return OBVIOUS.test(ua) || PREVIEW_FETCHERS.test(ua);
}
