import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "OpenFloor — Multiplayer agent development",
    description: "A shared control plane for teams coordinating coding agents against one software objective.",
    // basePath rewrites routes and bundled assets, not literal paths to files
    // in public/. Under /app those have to carry the prefix themselves, or they
    // resolve against the marketing site at the apex and 404.
    // openfloor-mark.png is 736x256, so a browser shrank it to a sliver in the
    // square tab slot. favicon.svg is the same mark drawn for that slot, and is
    // byte-identical to the one the marketing site serves.
    icons: { icon: "/app/favicon.svg", shortcut: "/app/favicon.svg" },
    openGraph: {
      type: "website",
      title: "OpenFloor",
      description: "Multiplayer development for agent teams.",
      images: [{ url: `${origin}/app/og-v3.png`, width: 1200, height: 630, alt: "OpenFloor — multiplayer development for agent teams" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenFloor",
      description: "Multiplayer development for agent teams.",
      images: [`${origin}/app/og-v3.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
