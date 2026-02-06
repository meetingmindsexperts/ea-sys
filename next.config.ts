import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

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
    ],
  },

  // Transpile specific packages for better tree-shaking
  transpilePackages: ["@getbrevo/brevo"],

  // Enable Turbopack (default in Next.js 16)
  turbopack: {},
};

export default nextConfig;
