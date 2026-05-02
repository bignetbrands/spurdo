import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "$spurdo :DDD",
  description: "spurdo haz arriv on solana :DDD",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
