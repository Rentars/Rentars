import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',

  // ── Image optimisation ────────────────────────────────────────────────────
  // Serve modern formats (WebP / AVIF) and constrain sizes so the image
  // optimiser never emits oversized assets that would bust the LCP budget.
  images: {
    // Prefer AVIF (smaller) then WebP as the format hierarchy.
    formats: ['image/avif', 'image/webp'],
    // Limit the responsive sizes the optimiser generates — keeps total image
    // weight inside the performance budget for property-card grids.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // 7-day CDN cache on optimised images (minimumCacheTTL is in seconds).
    minimumCacheTTL: 60 * 60 * 24 * 7,
    // `remotePatterns` supersedes the deprecated `domains` list and supports
    // wildcards, so we cover Supabase storage buckets and any future CDN host.
    remotePatterns: [
      // Unsplash (existing images used in seed data / stories)
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      // Supabase Storage — project URL varies per environment, so match any
      // *.supabase.co storage subdomain.
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/**',
      },
      // Self-hosted / local Supabase (docker) on localhost
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '54321',
        pathname: '/storage/v1/object/**',
      },
    ],
  },

  webpack(config, { isServer }) {
    // ── Path aliases ──────────────────────────────────────────────────────
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
      '@/components': path.resolve(__dirname, 'src/components'),
      '@/hooks': path.resolve(__dirname, 'src/hooks'),
      '@/services': path.resolve(__dirname, 'src/services'),
      '@/types': path.resolve(__dirname, 'src/types'),
      '@/lib': path.resolve(__dirname, 'src/lib'),
    };

    // ── Bundle analyser (client build only) ──────────────────────────────
    // Enable by running:  ANALYZE=true next build
    if (process.env.ANALYZE === 'true' && !isServer) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
      config.plugins.push(
        new BundleAnalyzerPlugin({
          analyzerMode: 'static',
          reportFilename: path.resolve(__dirname, 'bundle-report.html'),
          openAnalyzer: false,
          logLevel: 'info',
        }),
      );
    }

    return config;
  },

  // ── Experimental features for performance ─────────────────────────────────
  experimental: {
    // Optimise package imports so barrel files don't pull in unused code.
    // Covers the heaviest tree-shakeable packages used in this project.
    optimizePackageImports: [
      'lucide-react',
      '@stellar/stellar-sdk',
      'recharts',
      'date-fns',
    ],
  },
};

export default nextConfig;
