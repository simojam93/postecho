import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { tileSvg, bleedSvg } from "./postecho-mark.mjs";
// sharp comes from the web app's dependencies (Next ships it).
const require = createRequire(new URL("../../web/package.json", import.meta.url));
const sharp = require("sharp");
const out = process.argv[2] ?? ".";
const tile = Buffer.from(tileSvg());
const bleed = Buffer.from(bleedSvg());
writeFileSync(`${out}/icon.svg`, tileSvg());
const png = (svg, size) => sharp(svg, { density: Math.max(72, (72 * size) / 512 * 4) }).resize(size, size).png().toBuffer();

// favicon.ico: 16/32/48 PNG entries (PNG-in-ICO, supported by every current browser).
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((s) => png(tile, s)));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = pngs.map((buf, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i], 0); e.writeUInt8(sizes[i], 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
  offset += buf.length; return e;
});
writeFileSync(`${out}/favicon.ico`, Buffer.concat([header, ...entries, ...pngs]));
writeFileSync(`${out}/apple-icon.png`, await png(bleed, 180));

// Preview for the owner: the tile large, then 64/32/16 on a dark and a light tab bar, plus 16/32 blown up ×6 to judge them.
const big = await png(tile, 320);
const small = await Promise.all([64, 32, 16].map((s) => png(tile, s)));
const blow = async (s) => sharp(await png(tile, s)).resize(s * 6, s * 6, { kernel: "nearest" }).png().toBuffer();
const blown16 = await blow(16), blown32 = await blow(32);
const W = 900, H = 420;
const layers = [
  { input: { create: { width: W / 2, height: H, channels: 4, background: "#202124" } }, left: 0, top: 0 },
  { input: { create: { width: W / 2, height: H, channels: 4, background: "#f1f3f4" } }, left: W / 2, top: 0 },
  { input: big, left: 40, top: 50 },
  { input: small[0], left: 380, top: 60 }, { input: small[1], left: 380, top: 150 }, { input: small[2], left: 380, top: 210 },
  { input: small[0], left: W / 2 + 30, top: 60 }, { input: small[1], left: W / 2 + 30, top: 150 }, { input: small[2], left: W / 2 + 30, top: 210 },
  { input: blown16, left: W / 2 + 130, top: 60 }, { input: blown32, left: W / 2 + 130, top: 180 },
];
await sharp({ create: { width: W, height: H, channels: 4, background: "#000000" } }).composite(layers).png().toFile(`${out}/preview.png`);
console.log("rendered:", ["icon.svg", "favicon.ico", "apple-icon.png", "preview.png"].join(", "));
