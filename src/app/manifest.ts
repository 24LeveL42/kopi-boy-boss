import type { MetadataRoute } from "next";

// Makes the HQ admin app installable ("Add to Home screen" / Install app) with
// the KB Admin icon. Icons are generated from the KB_admin_skin artwork.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Kopi Boy Admin",
    short_name: "KB Admin",
    description: "Admin control center for Kopi Boy — merchants, riders, orders, complaints, revenue.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0B1B34", // --kb-navy, shown on the launch splash
    theme_color: "#0B1B34",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
