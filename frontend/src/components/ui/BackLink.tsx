import { Link } from 'react-router-dom';

export function BackLink({ to, label, className = '' }: { to: string; label: string; className?: string }) {
  return (
    <Link to={to} className={`mt-3 inline-block text-sm font-semibold text-brand-300 hover:text-brand-200 ${className}`.trim()}>
      &larr; {label}
    </Link>
  );
}
