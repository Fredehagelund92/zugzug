/* Icons — inline line icons on `currentColor`, so they inherit ink/accent from
   whatever text color the parent sets. 24x24, 1.6 stroke (matches the kit). */
import type { SVGProps } from "react";
import { cx } from "../lib/cx";

function Base({ className, children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-[18px] w-[18px] shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Base>
);
export const IconMapping = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="5" cy="6" r="2" />
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="12" r="2" />
    <path d="M7 6h4a4 4 0 0 1 4 4v0M7 18h4a4 4 0 0 0 4-4v0" />
  </Base>
);
export const IconTables = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M3 14h18M9 9v11" />
  </Base>
);
export const IconSources = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </Base>
);
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Base>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const IconArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Base>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Base>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M6 9l6 6 6-6" />
  </Base>
);
export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Base>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M9 6l6 6-6 6" />
  </Base>
);
export const IconSortAsc = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M7 4v16M7 4l-3 4M7 4l3 4M13 6h8M13 12h6M13 18h4" />
  </Base>
);
export const IconSortDesc = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M7 20V4M7 20l-3-4M7 20l3-4M13 6h4M13 12h6M13 18h8" />
  </Base>
);
export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);
export const IconEyeOff = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M3 3l18 18M10.6 6.1A10.5 10.5 0 0 1 12 6c6.5 0 10 7 10 7a17.7 17.7 0 0 1-3.6 4.3M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 4.5-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Base>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6" />
  </Base>
);
export const IconType = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M6 9V6h12v3M9 6v12M15 18h-6M13 6v12M16 14v2h6v-2M19 16v-6" />
  </Base>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
);
export const IconWand = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M5 21 19 7M14 4l1.5 1.5M19 9l1.5 1.5M9 3l.8 2 2 .8-2 .8L9 9l-.8-2L6.2 6.2 8.2 5z" />
  </Base>
);
export const IconPin = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M12 17v5M9 4h6l-1 5 3 3v2H7v-2l3-3z" />
  </Base>
);
export const IconFilter = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </Base>
);
export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </Base>
);
export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
  </Base>
);
export const IconMerge = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M7 4v6a5 5 0 0 0 5 5h8M16 11l4 4-4 4" />
  </Base>
);
export const IconEdit = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Base>
);

/* Field-type icons — used in column headers, header menus, and the add-field
   popover so a given type reads as the same glyph everywhere. */
export const IconFieldText = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M5 19 12 5l7 14M8 14h8" />
  </Base>
);
export const IconFieldNumber = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M9 4l-1 16M16 4l-1 16M4 9h17M3 15h17" />
  </Base>
);
export const IconFieldBoolean = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 12l3 3 5-6" />
  </Base>
);
export const IconFieldDate = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Base>
);
export const IconFieldSelect = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="9" width="8" height="6" rx="3" />
    <rect x="13" y="9" width="8" height="6" rx="3" />
  </Base>
);
export const IconMenu = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Base>
);
