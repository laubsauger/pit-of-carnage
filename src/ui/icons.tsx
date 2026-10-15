// Owned by: ui
// Small line icons drawn for this game (no emoji, no icon font). Stroke uses currentColor.
import type { ReactNode } from 'react';
import type { WeaponId } from '../core';

type IconProps = { size?: number; title?: string };

function Svg({ size = 16, title, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

const WEAPON_PATHS: Record<WeaponId, ReactNode> = {
  // Long blade on the diagonal with a crossguard and pommel
  GREATSWORD: (
    <>
      <path d="M13.5 2.5 6 10" />
      <path d="M13.5 2.5h-2.2M13.5 2.5v2.2" />
      <path d="M4.2 8.2l3.6 3.6" />
      <path d="M5.9 10.1 3 13" />
      <circle cx="2.6" cy="13.4" r="0.6" />
    </>
  ),
  // Handle and a heavy block head
  WARHAMMER: (
    <>
      <path d="M2.5 13.5 9 7" />
      <path d="M7.6 3.4l2-2 5 5-2 2z" />
    </>
  ),
  // Two short crossed blades
  TWIN_DAGGERS: (
    <>
      <path d="M3 3l6.2 6.2M2 6l3-3" />
      <path d="M13 3 6.8 9.2M14 6l-3-3" />
      <path d="M9.6 10.6 12 13M6.4 10.6 4 13" />
    </>
  ),
  // Handle with a crescent blade
  THROWING_AXES: (
    <>
      <path d="M3 13.5 10.5 6" />
      <path d="M8.2 3.6c1.6-1.6 4-1.7 5.6-.6.4 2-.5 4.4-2.4 5.6z" />
    </>
  ),
  // Bow limb and string with a nocked arrow
  LONGBOW: (
    <>
      <path d="M4 2c5 1.5 8 5 9 11" />
      <path d="M4 2l9 11" strokeWidth={0.9} />
      <path d="M2.5 9.5 9 6M9 6l-2.2-.2M9 6l-.9 2" />
    </>
  ),
  // Staff with an orb
  ARCANE_STAFF: (
    <>
      <path d="M3 13.5l7.5-7.5" />
      <circle cx="12" cy="4" r="2.2" />
      <path d="M12 1.2v.6M14.8 4h-.6" strokeWidth={1} />
    </>
  ),
};

export function WeaponIcon({ weapon, size = 14, title }: IconProps & { weapon: WeaponId }) {
  return (
    <Svg size={size} title={title}>
      {WEAPON_PATHS[weapon] ?? <circle cx="8" cy="8" r="5" />}
    </Svg>
  );
}

export function PlayIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 3.2v9.6L12.6 8z" fill="currentColor" />
    </Svg>
  );
}

export function PauseIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5.2 3.5v9M10.8 3.5v9" strokeWidth={2.2} />
    </Svg>
  );
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

/** Camera follow: a framing bracket around a dot. */
export function FollowIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function DiceIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <circle cx="5.6" cy="5.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function EyeIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </Svg>
  );
}

/** View settings: a plain cog. */
export function GearIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3" />
      <circle cx="8" cy="8" r="4.6" />
    </Svg>
  );
}

/** Timeline lanes: stacked tracks with marks. */
export function LanesIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2 4h12M2 8h12M2 12h12" strokeWidth={1.1} opacity={0.55} />
      <circle cx="5" cy="4" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Opens a file picker or import dialog: a tray with an arrow coming in. */
export function ImportIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 2v7.5M5 6.6 8 9.6l3-3" />
      <path d="M2.5 10.5v2.5h11v-2.5" />
    </Svg>
  );
}
