// Generates the Chrome extension icons as PNGs (no image tooling or binary files in the repo).
// A rounded blue square with a white "play" triangle.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function inside(x, y) {
  // Coordinates in [0,1]. Returns 'bg' | 'fg' | null.
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // Play triangle
  const ax = 0.3, ay = 0.24, bx = 0.3, by = 0.76, tx = 0.74, ty = 0.5;
  const s = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = s(ax, ay, bx, by), d2 = s(bx, by, tx, ty), d3 = s(tx, ty, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  if (!(neg && pos)) return 'fg';
  return 'bg';
}

export function makeIcon(size) {
  const SS = 4;
  const bg = [37, 99, 235];
  const fg = [255, 255, 255];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const hit = inside((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!hit) continue;
          const c = hit === 'fg' ? fg : bg;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      const n = SS * SS;
      const covered = a / 255;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = covered ? Math.round(r / covered) : 0;
      raw[o + 1] = covered ? Math.round(g / covered) : 0;
      raw[o + 2] = covered ? Math.round(b / covered) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
