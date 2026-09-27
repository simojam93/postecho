// PostEcho mark: a geometric "P" whose bowl sends out two fading echo arcs — a post that echoes.
// One source of truth for every size: tile (rounded, for browsers) and full-bleed (iOS masks it itself).
const SILVER = "#e6e8ec";
const BG = "#08080a";
const r = (n) => Math.round(n * 10) / 10;

export function markPaths({ dy = 16 } = {}) {
  const cx = 188, cy = 230 + dy;
  const arc = (radius, deg) => {
    const t = (deg * Math.PI) / 180;
    const x = r(cx + radius * Math.cos(t)), y1 = r(cy - radius * Math.sin(t)), y2 = r(cy + radius * Math.sin(t));
    return `M ${x} ${y1} A ${radius} ${radius} 0 0 1 ${x} ${y2}`;
  };
  return [
    `<path d="M 108 ${384 - 16 + dy} V ${144 + dy} H ${cx} A 86 86 0 0 1 ${cx} ${316 + dy} H 108" fill="none" stroke="${SILVER}" stroke-width="50" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="${arc(158, 52)}" fill="none" stroke="${SILVER}" stroke-opacity="0.62" stroke-width="34" stroke-linecap="round"/>`,
    `<path d="${arc(222, 38)}" fill="none" stroke="${SILVER}" stroke-opacity="0.3" stroke-width="26" stroke-linecap="round"/>`,
  ].join("\n  ");
}

export function tileSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="116" fill="${BG}"/>
  <rect x="3" y="3" width="506" height="506" rx="113" fill="none" stroke="#1f1f24" stroke-width="6"/>
  ${markPaths()}
</svg>
`;
}

export function bleedSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  <g transform="translate(51.2 51.2) scale(0.8)">
  ${markPaths()}
  </g>
</svg>
`;
}
