'use client';

import { useEffect, useState } from 'react';

/** A banner on every page outside production (for example "Staging"): test data only, never real children's details. */
export function EnvBanner() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/env')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { label?: string | null } | null) => setLabel(d?.label ?? null))
      .catch(() => setLabel(null));
  }, []);
  if (!label) return null;
  return (
    <div role="note" aria-label="Environment" style={{ background: '#e0a85a', color: '#1a1200', fontWeight: 700, fontSize: 14, textAlign: 'center', padding: '6px 12px' }}>
      {label}: test data only. Do not enter a real child&apos;s details.
    </div>
  );
}
