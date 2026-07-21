#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const [sourcePath, outputPath] = process.argv.slice(2);

if (!sourcePath || !outputPath) {
  console.error("Usage: generate-native-icon.mjs <source.png> <output.icns>");
  process.exit(2);
}

// Modern ICNS files store PNG renditions in typed chunks. The duplicated
// dimensions represent standard- and Retina-scale icon families.
const renditions = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

const chunks = await Promise.all(
  renditions.map(async ([type, size]) => {
    const png = await sharp(sourcePath)
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
    const chunk = Buffer.allocUnsafe(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  }),
);

const body = Buffer.concat(chunks);
const header = Buffer.allocUnsafe(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(header.length + body.length, 4);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.concat([header, body]));
