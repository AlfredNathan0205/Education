import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Exam App',
  description: 'Competitive curriculum-aligned assessment platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
