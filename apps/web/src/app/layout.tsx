import type { Metadata, Viewport } from 'next';
import './globals.css';
import { EnvBanner } from '@/components/EnvBanner';

export const metadata: Metadata = {
  title: 'Exam App',
  description: 'Competitive, curriculum-aligned practice and assessment for school students.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <EnvBanner />
        <div className="shell">
          <div className="brand"><span className="brand-mark" aria-hidden="true" />Exam App</div>
          <main id="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
