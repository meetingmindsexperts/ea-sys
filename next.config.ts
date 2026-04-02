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
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()" },
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
  serverExternalPackages: ["pdfkit", "@anthropic-ai/sdk"],

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
