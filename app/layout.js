import "./globals.css";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"], style: ["normal", "italic"] });
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600"] });

export const metadata = {
  title: "Traider",
  description: "Auto trade journaling, AI-guided discipline, and rule-based automation",
  manifest: "/manifest.json",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A0A0B",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${inter.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
