import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",

  // Security headers
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // SAMEORIGIN (was DENY before 2026-06-01) — DENY blocked our own
          // dashboard from iframing same-origin pages (e.g. the certificates
          // preview PDF), and the failure mode is browser-level + silent
          // (no server logs because the response never renders in the
          // frame). SAMEORIGIN still blocks external sites embedding our
          // pages for clickjacking — the only thing we used to also block
          // (which we now allow) is OUR OWN pages framing OUR OWN pages.
          // Matches the nginx-layer header at deploy/nginx.conf:26.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Modern equivalent — Content-Security-Policy frame-ancestors
          // supersedes X-Frame-Options on browsers that support both. 'self'
          // = only same-origin documents can frame us. Defense-in-depth
          // since some niche browsers ignore X-Frame-Options.
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()" },
        ],
      },
      {
        // Allow microphone for Zoom embedded meetings on session pages
        source: "/e/:slug/session/:path*",
        headers: [
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },

  // Allow Next.js Image optimization for Supabase Storage CDN URLs
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "api.eventsair.com",
      },
      {
        protocol: "https",
        hostname: "*.eventsair.com",
      },
      // Our own uploaded media is stored as ABSOLUTE URLs on the prod host
      // (e.g. https://events.meetingmindsgroup.com/uploads/media/.../x.jpg).
      // Even though it's same-origin, next/image treats an absolute URL as
      // remote and refuses to optimize a host that isn't allowlisted — which
      // silently broke public event/session banners. Scope to /uploads/** so
      // only our served-upload paths are eligible.
      {
        protocol: "https",
        hostname: "**.meetingmindsgroup.com",
        pathname: "/uploads/**",
      },
    ],
  },

  // Optimize barrel imports for large packages - reduces bundle size significantly
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "@radix-ui/react-icons",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
      "@radix-ui/react-avatar",
      "@radix-ui/react-tooltip",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/extension-link",
      "@tiptap/extension-image",
      "@tiptap/extension-text-align",
      "@tiptap/extension-color",
      "@tiptap/extension-text-style",
      "@tiptap/extension-underline",
      "@tiptap/extension-placeholder",
    ],
  },

  // Exclude pdfkit from bundling — it uses __dirname for font files (Helvetica.afm)
  // which Turbopack rewrites to /ROOT/, breaking font resolution
  serverExternalPackages: ["pdfkit", "@anthropic-ai/sdk", "@zoom/meetingsdk"],

  // Transpile specific packages for better tree-shaking
  transpilePackages: ["@getbrevo/brevo"],

  // Enable Turbopack (default in Next.js 16)
  turbopack: {},
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress source map upload logs unless in CI
  silent: !process.env.CI,

  // Disable telemetry
  telemetry: false,
});
