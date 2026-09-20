import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kopi Boy HQ",
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
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
