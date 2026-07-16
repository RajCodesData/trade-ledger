import "./globals.css";
import { Sora, JetBrains_Mono } from "next/font/google";

const sora = Sora({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700", "800"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600", "700"] });

export const metadata = {
  title: "trAIder",
  description: "Auto trade journaling, AI-guided discipline, and rule-based automation",
  manifest: "/manifest.json",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A0C14",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${sora.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
