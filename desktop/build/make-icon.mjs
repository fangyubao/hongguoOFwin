// 把 build/icon.png 转成多尺寸 build/icon.ico（NSIS 只认 ico）
// 纯 Node 实现：手写 PNG 解码 + 面积平均缩放 + 32 位 BMP/DIB 编码，无第三方依赖。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "icon.png");
const dst = path.join(here, "icon.ico");
const SIZES = [256, 128, 64, 48, 32, 16];

/* ---------- PNG 解码 ---------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是合法的 PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行扫描 PNG");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2))
    throw new Error(`仅支持 8 位 RGB/RGBA，当前 bitDepth=${bitDepth} colorType=${colorType}`);

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prior = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const offset = y * (stride + 1);
    const filter = raw[offset];
    raw.copy(cur, 0, offset + 1, offset + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prior[x];
      const c = x >= channels ? prior[x - channels] : 0;
      let value = cur[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = value & 0xff;
    }
    prior.set(cur);
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
  }
  return { width, height, data: out };
}

/* ---------- 面积平均缩放（预乘 alpha，避免边缘发黑） ---------- */
function resize(img, size) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = sw / size;
  const scaleY = sh / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = y * scaleY, y1 = Math.min(sh, y0 + scaleY);
    for (let x = 0; x < size; x += 1) {
      const x0 = x * scaleX, x1 = Math.min(sw, x0 + scaleX);
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          const alpha = data[i + 3] / 255;
          r += data[i] * alpha * w;
          g += data[i + 1] * alpha * w;
          b += data[i + 2] * alpha * w;
          a += data[i + 3] * w;
          weight += w;
        }
      }
      const d = (y * size + x) * 4;
      const alphaAvg = a / weight;
      const factor = alphaAvg > 0 ? 255 / alphaAvg : 0;
      out[d] = Math.min(255, Math.round((r / weight) * factor));
      out[d + 1] = Math.min(255, Math.round((g / weight) * factor));
      out[d + 2] = Math.min(255, Math.round((b / weight) * factor));
      out[d + 3] = Math.round(alphaAvg);
    }
  }
  return out;
}

/* ---------- 编码为 ICO 内的 32 位 DIB ---------- */
function toDib(pixels, size) {
  const xorSize = size * size * 4;
  const maskRow = Math.ceil(size / 32) * 4;
  const andSize = maskRow * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两段
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xorSize + andSize, 20);

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y += 1) {
    const srcRow = size - 1 - y; // DIB 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = pixels[s + 2];
      xor[d + 1] = pixels[s + 1];
      xor[d + 2] = pixels[s];
      xor[d + 3] = pixels[s + 3];
    }
  }
  const and = Buffer.alloc(andSize);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = pixels[((size - 1 - y) * size + x) * 4 + 3];
      if (alpha === 0) and[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, xor, and]);
}

/* ---------- 组装 ICO ---------- */
const png = decodePng(fs.readFileSync(src));
const images = SIZES.map((size) => {
  const dib = toDib(resize(png, size), size);
  return { size, dib };
});

const dir = Buffer.alloc(6 + images.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  dir.writeUInt8(image.size === 256 ? 0 : image.size, entry);
  dir.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
  dir.writeUInt8(0, entry + 2);
  dir.writeUInt8(0, entry + 3);
  dir.writeUInt16LE(1, entry + 4);
  dir.writeUInt16LE(32, entry + 6);
  dir.writeUInt32LE(image.dib.length, entry + 8);
  dir.writeUInt32LE(offset, entry + 12);
  offset += image.dib.length;
});

fs.writeFileSync(dst, Buffer.concat([dir, ...images.map((i) => i.dib)]));
console.log(
  `[icon] ${path.basename(src)} ${png.width}x${png.height} → ${path.basename(dst)} ` +
    `(${SIZES.join("/")}, ${(fs.statSync(dst).size / 1024).toFixed(1)} KB)`
);
