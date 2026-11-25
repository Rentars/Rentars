import type { NextConfig } from 'next';
import path from 'path';
import fs from 'fs';

// Build-time identifier used to version the service worker caches. Each
// deployment must produce a distinct value so stale assets are replaced.
const SW_CACHE_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  process.env.NEXT_PUBLIC_BUILD_ID ||
  `${Date.now()}`;

// Minimum SW/app version required for compatibility. When set, the service
// worker may force a reload only if the running version is older than this.
const SW_REQUIRED_MIN_VERSION = process.env.NEXT_PUBLIC_SW_REQUIRED_MIN_VERSION || '';

const SW_PLACEHOLDER = '__SW_CACHE_VERSION__';
const SW_MIN_VERSION_PLACEHOLDER = '__SW_REQUIRED_MIN_VERSION__';

/**
 * Replaces the cache-version placeholders in public/sw.js with the current
 * build id so every deployment ships a distinct, versioned cache namespace.
 */
class ServiceWorkerVersionPlugin {
  apply(compiler: any) {
    const { sources, Compilation } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('ServiceWorkerVersionPlugin', (compilation: any) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'ServiceWorkerVersionPlugin',
          stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const swPath = path.resolve(__dirname, 'public/sw.js');
          if (!fs.existsSync(swPath)) {
            return;
          }
          const original = fs.readFileSync(swPath, 'utf8');
          const versioned = original
            .split(SW_PLACEHOLDER)
            .join(SW_CACHE_VERSION)
            .split(SW_MIN_VERSION_PLACEHOLDER)
            .join(SW_REQUIRED_MIN_VERSION);
          compilation.emitAsset(
            'sw.js',
            new sources.RawSource(versioned),
          );
        },
      );
    });
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
  
  // Performance: compress static assets
  compress: true,
  
  // Performance: enable React strict mode for better development checks
  reactStrictMode: true,
  
  // Performance: optimize fonts
  optimizeFonts: true,
  
  // Performance: enable SWC minification
  swcMinify: true,
  
  images: {
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
    // Image optimization settings
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  
  // Expose the required minimum SW version to the client bundle.
  env: {
    NEXT_PUBLIC_SW_REQUIRED_MIN_VERSION: SW_REQUIRED_MIN_VERSION,
  },

  webpack(config) {
    config.plugins = config.plugins || [];
    config.plugins.push(new ServiceWorkerVersionPlugin());
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname, 'src'),
      '@/components': path.resolve(__dirname, 'src/components'),
      '@/hooks': path.resolve(__dirname, 'src/hooks'),
      '@/services': path.resolve(__dirname, 'src/services'),
      '@/types': path.resolve(__dirname, 'src/types'),
      '@/lib': path.resolve(__dirname, 'src/lib'),
    };
    return config;
  },
  
  // Experimental features for better performance
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts', 'leaflet', 'react-leaflet'],
  },
};

export default nextConfig;
