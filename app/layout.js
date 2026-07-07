import "./globals.css";

export const metadata = {
  title: "TradeLedger",
  description: "Auto trade journaling, guardrails and AI-assisted analytics",
  manifest: "/manifest.json",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0B0F14",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
