/** Staff pages use the same design tokens as the student app, on a wider page (tables and long forms). */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="wide">{children}</div>;
}
