/**
 * OpenCode logo as an inline SVG React component.
 *
 * Source: opencode-logo-dark.svg. Renders the logo mark at a size controlled
 * by the parent's CSS (e.g. the Button component's `[&_svg]:size-4` rule
 * scales it to 16×16). Uses the original brand colors:
 *  - frame: #F1ECEC (off-white)
 *  - inner: #4B4646 (dark gray)
 */

export function OpencodeLogo({ className }: { className?: string }) {
  return (
    <svg
      width="240"
      height="300"
      viewBox="0 0 240 300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <g clipPath="url(#opencode-logo-clip)">
        <mask
          id="opencode-logo-mask"
          style={{ maskType: "luminance" }}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="240"
          height="300"
        >
          <path d="M240 0H0V300H240V0Z" fill="white" />
        </mask>
        <g mask="url(#opencode-logo-mask)">
          <path d="M180 240H60V120H180V240Z" fill="#4B4646" />
          <path
            d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"
            fill="#F1ECEC"
          />
        </g>
      </g>
      <defs>
        <clipPath id="opencode-logo-clip">
          <rect width="240" height="300" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
