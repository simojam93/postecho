/**
 * The PostEcho logomark (owner, 2026-09-24: "add the icon also close to the
 * name in the web app"): the app icon's drawing without its tile — a
 * geometric P whose bowl sends out two fading echo arcs (docs/brand/
 * postecho-mark.mjs; same paths as app/icon.svg). Stroked in currentColor,
 * so a text-* class colours it; sized by its height, with the width
 * following the cropped viewBox. Decorative: the wordmark next to it
 * carries the name.
 */
export function BrandMark({ className = "h-[18px] w-auto text-accent" }: { className?: string }) {
  return (
    <svg viewBox="80 93 346 319" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <path
        d="M 108 384 V 160 H 188 A 86 86 0 0 1 188 332 H 108"
        fill="none" stroke="currentColor" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M 285.3 121.5 A 158 158 0 0 1 285.3 370.5" fill="none" stroke="currentColor" strokeOpacity="0.62" strokeWidth="34" strokeLinecap="round" />
      <path d="M 362.9 109.3 A 222 222 0 0 1 362.9 382.7" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="26" strokeLinecap="round" />
    </svg>
  );
}
