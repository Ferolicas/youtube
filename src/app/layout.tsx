import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Planeta Keto · Inteligencia de Canal",
  description: "Análisis quirúrgico del canal Planeta Keto (uso personal).",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
