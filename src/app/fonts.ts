/**
 * Self-hosted webfonts (Aug 11, 2026).
 *
 * WHY THESE ARE VENDORED. These three were loaded through `next/font/google`,
 * which downloads the .woff2 files from fonts.gstatic.com AT BUILD TIME. That
 * made every production image build depend on Google's CDN being internally
 * consistent at that instant, and on Aug 11 it was not: Google rotated the
 * Fraunces v38 file set, some edge nodes kept serving cached CSS pointing at
 * files gstatic had already removed, and the deploy failed with a 404 that
 * Next reports as the very unhelpful "Module not found: Can't resolve
 * '@vercel/turbopack-next/internal/font/google/font'" (run 1309).
 *
 * The failure was harmless that day, six minutes and one re-push. The exposure
 * is not: the pipeline could not have shipped a hotfix during that window, and
 * the font that blocked it is on /api-docs. Note also that the GATING build
 * job passed in the same run, because it is a separate cold build minutes
 * earlier against a mutable third party. A green gate never protected the
 * image build.
 *
 * General rule this is an instance of: anything the build downloads is a
 * dependency of your ability to deploy. Vendor it.
 *
 * WHAT IS HERE. The `latin` subset only, matching the `subsets: ["latin"]`
 * every loader already requested, so nothing renders differently. Geist and
 * Geist Mono are the variable files covering 100..900; Fraunces is the
 * variable file covering the 300..700 range /api-docs asks for, and JetBrains
 * Mono for the log viewer. 145 KB total.
 *
 * UPDATING. Deliberately a manual, explicit act now rather than something that
 * happens silently on the next build. Fetch the CSS with a modern Chrome
 * User-Agent (Google serves .woff2 only to browsers it recognises), take the
 * url from the @font-face block whose unicode-range begins U+0000-00FF, and
 * replace the file:
 *
 *   curl -H 'User-Agent: Mozilla/5.0 ... Chrome/104.0.0.0 ...' \
 *     'https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap'
 */
import localFont from "next/font/local";

export const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  // Stated explicitly because a local font has no metadata telling Next the
  // axis range; without it the browser cannot synthesise the weights the UI
  // asks for and everything renders at 400.
  weight: "100 900",
  style: "normal",
});

export const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
  style: "normal",
});

/** Terminal face for the SUPER_ADMIN log viewer's retro theme. */
export const logMono = localFont({
  src: "./fonts/jetbrains-mono-latin.woff2",
  variable: "--font-log-mono",
  display: "swap",
  weight: "400 700",
  style: "normal",
});

/** Display face for the public API reference page only. */
export const apiDisplay = localFont({
  src: "./fonts/fraunces-latin.woff2",
  variable: "--font-api-display",
  display: "swap",
  weight: "300 700",
  style: "normal",
});
