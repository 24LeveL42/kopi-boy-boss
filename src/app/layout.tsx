import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted by next/font at build time; feeds --font-body in globals.css.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Kopi Boy Operations Centre",
  description: "Admin control center for Kopi Boy — merchants, riders, orders, complaints, revenue.",
  // iOS "Add to Home Screen": launch full-screen with the KB Admin name.
  // (The home-screen icon comes from src/app/apple-icon.png.)
  appleWebApp: { capable: true, title: "KB Admin", statusBarStyle: "black" },
};

export const viewport: Viewport = {
  themeColor: "#0B1B34", // --kb-navy: tints the browser/status bar to match the app
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
