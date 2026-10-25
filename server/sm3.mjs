// 纯 JS 的 SM3（GB/T 32905-2016）。
// Electron 用的是 BoringSSL，没有 sm3 摘要算法，会抛 "Digest method not supported"，
// 而上游签名（x-gorgon / x-medusa）依赖 SM3，所以必须自带一份。
const IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

const rotl = (x, n) => {
  const s = n & 31;
  return s === 0 ? x >>> 0 : ((x << s) | (x >>> (32 - s))) >>> 0;
};
const P0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const P1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
const T = (j) => (j <= 15 ? 0x79cc4519 : 0x7a879d8a);
const FF = (j, x, y, z) => (j <= 15 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0);
const GG = (j, x, y, z) => (j <= 15 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0);

const W = new Uint32Array(68);
const W1 = new Uint32Array(64);
const V = new Uint32Array(8);

function compress(block, offset) {
  for (let i = 0; i < 16; i += 1) W[i] = block.readUInt32BE(offset + i * 4);
  for (let j = 16; j < 68; j += 1) {
    const t = (W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15)) >>> 0;
    W[j] = (P1(t) ^ rotl(W[j - 13], 7) ^ W[j - 6]) >>> 0;
  }
  for (let j = 0; j < 64; j += 1) W1[j] = (W[j] ^ W[j + 4]) >>> 0;

  let A = V[0], B = V[1], C = V[2], D = V[3];
  let E = V[4], F = V[5], G = V[6], H = V[7];

  for (let j = 0; j < 64; j += 1) {
    const a12 = rotl(A, 12);
    const SS1 = rotl((a12 + E + rotl(T(j), j)) >>> 0, 7);
    const SS2 = (SS1 ^ a12) >>> 0;
    const TT1 = (FF(j, A, B, C) + D + SS2 + W1[j]) >>> 0;
    const TT2 = (GG(j, E, F, G) + H + SS1 + W[j]) >>> 0;
    D = C;
    C = rotl(B, 9);
    B = A;
    A = TT1;
    H = G;
    G = rotl(F, 19);
    F = E;
    E = P0(TT2);
  }

  V[0] = (V[0] ^ A) >>> 0;
  V[1] = (V[1] ^ B) >>> 0;
  V[2] = (V[2] ^ C) >>> 0;
  V[3] = (V[3] ^ D) >>> 0;
  V[4] = (V[4] ^ E) >>> 0;
  V[5] = (V[5] ^ F) >>> 0;
  V[6] = (V[6] ^ G) >>> 0;
  V[7] = (V[7] ^ H) >>> 0;
}

export function sm3(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  IV.forEach((v, i) => {
    V[i] = v;
  });

  const full = Math.floor(data.length / 64) * 64;
  for (let i = 0; i < full; i += 64) compress(data, i);

  const rest = data.subarray(full);
  const padLen = rest.length + 1 + 8 <= 64 ? 64 : 128;
  const tail = Buffer.alloc(padLen);
  rest.copy(tail);
  tail[rest.length] = 0x80;
  const bits = data.length * 8;
  tail.writeUInt32BE(Math.floor(bits / 0x100000000), padLen - 8);
  tail.writeUInt32BE(bits >>> 0, padLen - 4);
  for (let i = 0; i < padLen; i += 64) compress(tail, i);

  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(V[i], i * 4);
  return out;
}

/** 模仿 Node 的 Hash 接口，供上游脚本里的 crypto.createHash('sm3') 直接替换 */
export class Sm3Hash {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
  }
  update(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.chunks.push(buf);
    this.bytes += buf.length;
    return this;
  }
  digest(encoding) {
    const out = sm3(Buffer.concat(this.chunks, this.bytes));
    this.chunks = [];
    this.bytes = 0;
    if (!encoding || encoding === "buffer") return out;
    return out.toString(encoding);
  }
}

/** 只要 'sm3' 用自研实现，其余摘要照旧走 Node/BoringSSL；force 时强制走纯 JS（用于校验） */
export function createHashCompat(cryptoModule, name, force = false) {
  if (String(name).toLowerCase() === "sm3") {
    if (!force) {
      try {
        return cryptoModule.createHash(name);
      } catch {
        /* BoringSSL 无 sm3，落到纯 JS */
      }
    }
    return new Sm3Hash();
  }
  return cryptoModule.createHash(name);
}
