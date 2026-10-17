import Link from 'next/link';

export type NavTab = 'home' | 'tests' | 'progress' | 'compete' | 'profile';

const ICON: Record<NavTab, React.ReactNode> = {
  home: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z" />,
  tests: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  progress: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  compete: <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" />,
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </>
  ),
};

const TABS: Array<{ key: NavTab; href: string; label: string }> = [
  { key: 'home', href: '/home', label: 'Home' },
  { key: 'tests', href: '/tests', label: 'Test' },
  { key: 'progress', href: '/progress', label: 'Progress' },
  { key: 'compete', href: '/compete', label: 'Compete' },
  { key: 'profile', href: '/profile', label: 'Profile' },
];

/**
 * Main navigation for signed-in students (spec STUDENT_WEB: Home / Test / Progress / Compete / Profile). As on the
 * blueprint: a bottom tab bar with icons on phones, a sidebar with the brand on desktop (the layout is in globals.css).
 */
export function AppNav({ current }: { current: NavTab }) {
  return (
    <nav className="appnav" aria-label="Main">
      <div className="brand nav-brand" aria-hidden="true"><span className="brand-mark" />Exam App</div>
      <ul>
        {TABS.map((t) => (
          <li key={t.key}>
            <Link href={t.href} aria-current={t.key === current ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {ICON[t.key]}
              </svg>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
