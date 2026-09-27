import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipLayer } from "@/components/tooltip-layer";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PostEcho",
  description: "From videos and trends to scheduled posts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geistMono.variable} antialiased`}>
        {children}
        {/* One tooltip for every data-tip in the app (2026-09-27). */}
        <TooltipLayer />
      </body>
    </html>
  );
}
