const SIZE_CLASSES = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-3 py-1.5 text-xs',
};

/**
 * Generic dot+pill rendering primitive shared by run/StatusBadge,
 * report/ReportStatusBadge, and ClientDetailsCard's Active/Inactive pill --
 * each domain keeps its own status-to-tone/label map (the run/report state
 * machines are deliberately kept separate on the backend) and passes the
 * resolved tone className + label in here rather than this component owning
 * any status enum itself.
 */
export function StatusBadge({
  label,
  toneClassName,
  dot = true,
  mono = false,
  size = 'md',
  className = '',
}: {
  label: string;
  toneClassName: string;
  dot?: boolean;
  mono?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center rounded-full font-semibold tracking-wide ${SIZE_CLASSES[size]} ${mono ? 'font-mono' : ''} ${toneClassName} ${className}`.trim()}>
      {dot && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {label}
    </span>
  );
}
