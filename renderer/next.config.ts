import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  distDir: process.env.NODE_ENV === "production" ? "../app" : ".next",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // React Flow + Electron: avoid server-only optimizations.
  reactStrictMode: true,
};

export default config;
