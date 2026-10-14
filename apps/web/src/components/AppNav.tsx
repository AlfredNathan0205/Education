import Link from 'next/link';

export type NavTab = 'home' | 'tests' | 'progress' | 'compete' | 'profile';

const TABS: Array<{ key: NavTab; href: string; label: string }> = [
  { key: 'home', href: '/home', label: 'Home' },
  { key: 'tests', href: '/tests', label: 'Test' },
  { key: 'progress', href: '/progress', label: 'Progress' },
  { key: 'compete', href: '/compete', label: 'Compete' },
  { key: 'profile', href: '/profile', label: 'Profile' },
];

/** Main navigation for signed-in students (spec STUDENT_WEB: Home / Test / Progress / Compete / Profile). */
export function AppNav({ current }: { current: NavTab }) {
  return (
    <nav className="appnav" aria-label="Main">
      <ul>
        {TABS.map((t) => (
          <li key={t.key}>
            <Link href={t.href} aria-current={t.key === current ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
