import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Logos are served at quality 100 (default 75 smears fine edges into mush).
    qualities: [75, 100],
  },
};

export default nextConfig;
