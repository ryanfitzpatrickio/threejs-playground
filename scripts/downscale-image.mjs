import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [src, dst] = [process.argv[2], process.argv[3]];
const targetW = Number(process.argv[4] ?? 480);
const png = PNG.sync.read(readFileSync(src));
const ratio = targetW / png.width;
const tw = Math.round(png.width * ratio), th = Math.round(png.height * ratio);
const out = new PNG({ width: tw, height: th });
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
  const si = (png.width * Math.floor(y / ratio) + Math.floor(x / ratio)) << 2;
  const di = (tw * y + x) << 2;
  out.data.set(png.data.subarray(si, si + 4), di);
}
writeFileSync(dst, PNG.sync.write(out));
console.log(`${path.basename(dst)}: ${tw}x${th}`);
