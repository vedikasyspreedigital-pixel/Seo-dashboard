export function InlineError({ message, className = '' }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return <p className={`text-sm font-medium text-rose-300 ${className}`.trim()}>{message}</p>;
}
