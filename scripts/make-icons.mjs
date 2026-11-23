import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { crc32 } from "../extension/core/zip.js";

const output = new URL("../extension/icons/", import.meta.url);
await mkdir(output, { recursive: true });
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ink = [27, 49, 41, 255];
const paper = [247, 247, 238, 255];
const mint = [182, 223, 184, 255];
function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function colorAt(x, y) {
  if (Math.hypot(Math.max(0, Math.abs(x - 64) - 34), Math.max(0, Math.abs(y - 64) - 34)) > 24) {
    return [0, 0, 0, 0];
  }
  if (segmentDistance(x, y, 66, 67, 77, 78) <= 4.5 ||
      segmentDistance(x, y, 77, 78, 101, 51) <= 4.5) return mint;
  if ([45, 63, 81].some((line) => segmentDistance(x, y, 29, line, 54, line) <= 4)) return paper;
  return ink;
}

function chunk(name, data) {
  const typeAndData = Buffer.concat([Buffer.from(name), data]);
  const size = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([size, typeAndData, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const color = colorAt((x + (sx + 0.5) / 4) * 128 / size, (y + (sy + 0.5) / 4) * 128 / size);
          for (let channel = 0; channel < 4; channel++) sum[channel] += color[channel];
        }
      }
      const start = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) pixels[start + i] = sum[3] ? Math.round(sum[i] * 255 / sum[3]) : 0;
      pixels[start + 3] = Math.round(sum[3] / 16);
    }
  }
  await writeFile(new URL(`icon-${size}.png`, output), Buffer.concat([
    pngHeader, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]));
}
