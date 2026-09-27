// The repository's social preview (1280×640): the mark, the name and the one line it says, on the app's background.
// Run: node docs/brand/render-social.mjs <output.png> (sharp comes from web/node_modules, as render-icons.mjs).
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { markPaths } from "./postecho-mark.mjs";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const sharp = require("sharp");
const out = process.argv[2] ?? "social-preview.png";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <rect width="1280" height="640" fill="#08080a"/>
  <rect x="1" y="1" width="1278" height="638" fill="none" stroke="#1f1f24" stroke-width="2"/>
  <g transform="translate(120 188) scale(0.5)">
  ${markPaths()}
  </g>
  <text x="400" y="300" font-family="${FONT}" font-size="104" font-weight="700" letter-spacing="-2"><tspan fill="#8b8d93">Post</tspan><tspan fill="#e6e8ec">Echo</tspan></text>
  <text x="404" y="372" font-family="${FONT}" font-size="34" fill="#8b8d93">Find what's worth posting about, write it</text>
  <text x="404" y="418" font-family="${FONT}" font-size="34" fill="#8b8d93">in your own voice, schedule it on X and LinkedIn.</text>
</svg>`;

writeFileSync(out, await sharp(Buffer.from(svg)).png().toBuffer());
console.log(`saved ${out}`);
