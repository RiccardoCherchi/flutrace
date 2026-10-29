import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const base = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const LinkIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7 4.5 8.2 3.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" />
    <path d="M9 11.5 7.8 12.7a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
  </svg>
);
export const SearchIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </svg>
);
export const CloseIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </svg>
);
export const ClearIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m4.2 11.8 7.6-7.6" />
  </svg>
);
export const WarningIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M8 2.5 14 13H2L8 2.5Z" />
    <path d="M8 6.5v3M8 11.3v.01" />
  </svg>
);
export const JsonIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M5.5 3C4 3 4.5 5.5 4 6.5S2.5 8 2.5 8 3.5 8.5 4 9.5s-.5 3.5 1.5 3.5M10.5 3c1.5 0 1 2.5 1.5 3.5s1.5 1.5 1.5 1.5-1 .5-1.5 1.5.5 3.5-1.5 3.5" />
  </svg>
);
export const ImageIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <circle cx="6" cy="6.5" r="1" />
    <path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5L13 12" />
  </svg>
);
export const DocumentIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M4 2.5h5l3 3v8H4v-11Z" />
    <path d="M9 2.5v3h3" />
  </svg>
);
export const FailedIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m6 6 4 4M10 6l-4 4" />
  </svg>
);
export const PulseIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
  </svg>
);
export const FilterIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M2.5 3.5h11L9.5 8.5v4l-3-1.5V8.5l-4-5Z" />
  </svg>
);
export const DeviceIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
    <path d="M7.2 12.3h1.6" />
  </svg>
);
export const CopyIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
  </svg>
);
export const CheckIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);
export const GearIcon = (props: IconProps) => <svg {...base} {...props}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /><circle cx="8" cy="8" r="4.2" /></svg>;
