import type { Metadata } from "next";
import { Archivo, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { BASE_PATH } from "@/components/basePath";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// opnflr.com's own logotype face, loaded only for the pre-auth entry screen
// (app/page.tsx) — the rest of the app keeps Geist.
const brandSans = Archivo({ variable: "--font-brand-sans", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "openfloor — Multiplayer agent development",
    description: "A shared control plane for teams coordinating coding agents against one software objective.",
    // basePath rewrites routes and bundled assets, not literal paths to files
    // in public/. Under /app those have to carry the prefix themselves, or they
    // resolve against the marketing site at the apex and 404.
    // openfloor-mark.png is 736x256, so a browser shrank it to a sliver in the
    // square tab slot. favicon.svg is the same mark drawn for that slot, and is
    // byte-identical to the one the marketing site serves.
    icons: { icon: `${BASE_PATH}/favicon.svg`, shortcut: `${BASE_PATH}/favicon.svg` },
    openGraph: {
      type: "website",
      title: "openfloor",
      description: "Multiplayer development for agent teams.",
      images: [{ url: `${origin}${BASE_PATH}/og-v3.png`, width: 1200, height: 630, alt: "openfloor — multiplayer development for agent teams" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "openfloor",
      description: "Multiplayer development for agent teams.",
      images: [`${origin}${BASE_PATH}/og-v3.png`],
    },
  };
}

// Applies a saved manual theme before first paint so it never flashes the
// other theme. System-followers get no attribute and ride prefers-color-scheme.
const themeScript = `try{var t=localStorage.getItem("openfloor:theme");if(t==="light"||t==="dark"||t==="polar"||t==="midnight")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className={`${geistSans.variable} ${geistMono.variable} ${brandSans.variable}`}>{children}</body>
    </html>
  );
}
