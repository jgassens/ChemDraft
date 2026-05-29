import type { SVGProps } from "react";

export type IconName =
  | "align"
  | "atom"
  | "bond"
  | "bracket"
  | "charge"
  | "chain"
  | "copy"
  | "export"
  | "grid"
  | "group"
  | "inspector"
  | "lasso"
  | "mechanism"
  | "new"
  | "open"
  | "palette"
  | "paste"
  | "plugin"
  | "redo"
  | "ring"
  | "save"
  | "select"
  | "style"
  | "text"
  | "undo"
  | "zoomIn"
  | "zoomOut";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props
  };

  switch (name) {
    case "align":
      return (
        <svg {...common}>
          <path d="M6 5v14" />
          <path d="M10 7h8" />
          <path d="M10 12h5" />
          <path d="M10 17h9" />
        </svg>
      );
    case "atom":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2.2" />
          <path d="M4 12c2.4-4 13.6-4 16 0" />
          <path d="M4 12c2.4 4 13.6 4 16 0" />
          <path d="M12 4c4 2.4 4 13.6 0 16" />
          <path d="M12 4c-4 2.4-4 13.6 0 16" />
        </svg>
      );
    case "bond":
      return (
        <svg {...common}>
          <path d="M5 17 19 7" />
          <circle cx="5" cy="17" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="19" cy="7" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "bracket":
      return (
        <svg {...common}>
          <path d="M9 5H6v14h3" />
          <path d="M15 5h3v14h-3" />
        </svg>
      );
    case "charge":
      return (
        <svg {...common}>
          <path d="M12 5v8" />
          <path d="M8 9h8" />
          <path d="M7 18h10" />
        </svg>
      );
    case "chain":
      return (
        <svg {...common}>
          <path d="m4 14 4-4 4 4 4-4 4 4" />
          <circle cx="4" cy="14" r="1" fill="currentColor" stroke="none" />
          <circle cx="20" cy="14" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="8" y="8" width="10" height="10" rx="1" />
          <path d="M6 15H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" />
        </svg>
      );
    case "export":
      return (
        <svg {...common}>
          <path d="M12 4v10" />
          <path d="m8 8 4-4 4 4" />
          <path d="M5 14v5h14v-5" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common}>
          <path d="M5 5h14v14H5z" />
          <path d="M5 10h14" />
          <path d="M5 15h14" />
          <path d="M10 5v14" />
          <path d="M15 5v14" />
        </svg>
      );
    case "group":
      return (
        <svg {...common}>
          <rect x="5" y="5" width="7" height="7" rx="1" />
          <rect x="12" y="12" width="7" height="7" rx="1" />
          <path d="M12 8h4v4" />
        </svg>
      );
    case "inspector":
      return (
        <svg {...common}>
          <path d="M6 5h12" />
          <path d="M6 12h12" />
          <path d="M6 19h12" />
          <circle cx="9" cy="5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="11" cy="19" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "lasso":
      return (
        <svg {...common}>
          <path d="M7 7c3-3 10-2 11 2 1.2 4.9-7.5 6.5-11.2 3.3C3.7 9.6 4.7 8.2 7 7Z" />
          <path d="M12 14c.6 3-1.4 5-4.8 5" />
        </svg>
      );
    case "mechanism":
      return (
        <svg {...common}>
          <path d="M5 15c5-9 11-9 14-3" />
          <path d="m16 10 3 2-3 2" />
          <circle cx="6" cy="16" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "new":
      return (
        <svg {...common}>
          <path d="M7 4h7l4 4v12H7z" />
          <path d="M14 4v5h4" />
          <path d="M9.5 14H15" />
          <path d="M12.25 11.25v5.5" />
        </svg>
      );
    case "open":
      return (
        <svg {...common}>
          <path d="M4 8h6l2 2h8v9H4z" />
          <path d="M4 8v-2h7l2 2" />
        </svg>
      );
    case "palette":
      return (
        <svg {...common}>
          <path d="M6 5h12v14H6z" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h4" />
        </svg>
      );
    case "paste":
      return (
        <svg {...common}>
          <path d="M9 5h6l1 2h3v13H5V7h3z" />
          <path d="M9 5v3h6V5" />
        </svg>
      );
    case "plugin":
      return (
        <svg {...common}>
          <path d="M9 4v5" />
          <path d="M15 4v5" />
          <path d="M7 9h10v4a5 5 0 0 1-10 0z" />
          <path d="M12 18v2" />
        </svg>
      );
    case "redo":
      return (
        <svg {...common}>
          <path d="M19 8v5h-5" />
          <path d="M19 13c-2.2-4.4-9.5-5.4-13-1.4" />
        </svg>
      );
    case "ring":
      return (
        <svg {...common}>
          <path d="m12 4 7 4v8l-7 4-7-4V8z" />
          <path d="m8 10 4-2 4 2v4l-4 2-4-2z" />
        </svg>
      );
    case "save":
      return (
        <svg {...common}>
          <path d="M5 5h12l2 2v12H5z" />
          <path d="M8 5v5h7V5" />
          <path d="M8 19v-5h8v5" />
        </svg>
      );
    case "select":
      return (
        <svg {...common}>
          <path d="M6 4v15l4-3 2.4 4.2 2.6-1.5-2.4-4.1H17z" />
        </svg>
      );
    case "style":
      return (
        <svg {...common}>
          <path d="M6 17h12" />
          <path d="M8 14 13 4l5 10" />
          <path d="M10 10h6" />
        </svg>
      );
    case "text":
      return (
        <svg {...common}>
          <path d="M6 6h12" />
          <path d="M12 6v12" />
          <path d="M9 18h6" />
        </svg>
      );
    case "undo":
      return (
        <svg {...common}>
          <path d="M5 8v5h5" />
          <path d="M5 13c2.2-4.4 9.5-5.4 13-1.4" />
        </svg>
      );
    case "zoomIn":
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="5" />
          <path d="M14 14 20 20" />
          <path d="M10 7v6" />
          <path d="M7 10h6" />
        </svg>
      );
    case "zoomOut":
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="5" />
          <path d="M14 14 20 20" />
          <path d="M7 10h6" />
        </svg>
      );
  }
}
