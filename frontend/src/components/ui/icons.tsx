import type { SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>) {
  return {
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M16.5 16.5L13 13" />
    </svg>
  );
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M5 8a5 5 0 0 1 10 0c0 3.2 1 4.5 1.5 5H3.5c.5-.5 1.5-1.8 1.5-5Z" />
      <path d="M8.2 16a1.8 1.8 0 0 0 3.6 0" />
    </svg>
  );
}

export function CheckCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7 10.2l2 2 4-4.4" />
    </svg>
  );
}

export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 6v4l2.6 1.6" />
    </svg>
  );
}

export function LoaderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 3.5a6.5 6.5 0 1 0 6.5 6.5" />
      <path d="M15.2 4.8l1.3-1.3" />
    </svg>
  );
}

export function AlertTriangleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 3.3l8 14H2l8-14Z" />
      <path d="M10 8.3v3.4" />
      <circle cx="10" cy="14.4" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function XCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" />
    </svg>
  );
}

export function GridIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="6" height="6" rx="1.3" />
      <rect x="11" y="3" width="6" height="6" rx="1.3" />
      <rect x="3" y="11" width="6" height="6" rx="1.3" />
      <rect x="11" y="11" width="6" height="6" rx="1.3" />
    </svg>
  );
}

export function DocumentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 2.5h6l4 4V17a0.5 0.5 0 0 1-0.5 0.5h-9A0.5 0.5 0 0 1 6 17V3a0.5 0.5 0 0 1 0-0.5Z" />
      <path d="M12 2.5V6.5h4" />
      <path d="M8 10.5h6M8 13.5h6" />
    </svg>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3L4.9 4.9" />
    </svg>
  );
}

export function BarChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)} strokeWidth={2}>
      <path d="M4 16V10M10 16V4M16 16v-7" />
    </svg>
  );
}

export function UploadDropIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 3v9.5M6.2 8.7L10 12.5l3.8-3.8" />
      <path d="M4 14.5v1a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </svg>
  );
}

export function LayoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="3" width="15" height="14" rx="2" />
      <path d="M2.5 8h15" />
      <path d="M7.5 8v9" />
    </svg>
  );
}

export function UserIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.5 16.5c1-3 3.6-4.5 6.5-4.5s5.5 1.5 6.5 4.5" />
    </svg>
  );
}

export function PlayCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8.3 7.2l4.6 2.8-4.6 2.8V7.2Z" />
    </svg>
  );
}

export function TrendUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M3 13.5l4.8-5 3 3L17 5" />
      <path d="M12.5 5h4.5v4.5" />
    </svg>
  );
}

export function TrendDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M3 6.5l4.8 5 3-3L17 15" />
      <path d="M12.5 15h4.5v-4.5" />
    </svg>
  );
}

export function MinusCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.5 10h7" />
    </svg>
  );
}

export function TargetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7.2" />
      <circle cx="10" cy="10" r="4" />
      <circle cx="10" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M13.5 3.5a1.7 1.7 0 0 1 2.4 2.4L6.5 15.3l-3.3.8.8-3.3 9.5-9.3Z" />
      <path d="M11.7 5.3l2.4 2.4" />
    </svg>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h12" />
      <path d="M7.5 6V4.5A1.5 1.5 0 0 1 9 3h2a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M5.5 6l.6 9.5A1.5 1.5 0 0 0 7.6 17h4.8a1.5 1.5 0 0 0 1.5-1.5l.6-9.5" />
      <path d="M8.5 9v5M11.5 9v5" />
    </svg>
  );
}

export function PowerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M10 3v6" />
      <path d="M14.2 5.8a6.2 6.2 0 1 1-8.4 0" />
    </svg>
  );
}

export function UndoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M5 8.5H12a4 4 0 0 1 0 8H8" />
      <path d="M7.5 5.5L4.5 8.5l3 3" />
    </svg>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 10a6 6 0 0 1 10.5-4M16 10a6 6 0 0 1-10.5 4" />
      <path d="M14.5 3.5v3h-3M5.5 16.5v-3h3" />
    </svg>
  );
}
