/** The app's half of the rover's control-link security. Mirrors raspberry_pi/security.py.
 *
 * Plain functions over strings and bytes: no randomness (nonces are passed in), no
 * network. They are checked by running them against Python's hmac module on the
 * same inputs, because a one-bit difference here just looks like "wrong token".
 *
 * The token never crosses the network. The app signs a random challenge with it,
 * the rover proves it holds the token too, and every message after that carries a
 * sequence number and an HMAC under a key derived for that connection alone.
 */

const AUTH_LABEL = "agni-auth";
const SESSION_LABEL = "agni-session";
const SERVER_PROOF_LABEL = "agni-server";
const CLIENT_TO_ROVER = "c2r";
const ROVER_TO_CLIENT = "r2c";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function utf8(text: string): Uint8Array {
  // TextEncoder is not guaranteed under Hermes; this covers every code point.
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLength = message.length * 8;
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let block = key.length > 64 ? sha256(key) : key;
  const padded = new Uint8Array(64);
  padded.set(block);
  block = padded;
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

export function hmacHex(key: Uint8Array, message: string): string {
  return toHex(hmacSha256(key, utf8(message)));
}

/** Compare two hex signatures without stopping at the first difference. */
export function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authProof(token: string, roverNonce: string, clientNonce: string): string {
  return hmacHex(utf8(token), `${AUTH_LABEL}|${roverNonce}|${clientNonce}`);
}

export function sessionKey(token: string, roverNonce: string, clientNonce: string): Uint8Array {
  return fromHex(hmacHex(utf8(token), `${SESSION_LABEL}|${roverNonce}|${clientNonce}`));
}

export function serverProof(key: Uint8Array): string {
  return hmacHex(key, SERVER_PROOF_LABEL);
}

export type Envelope = { seq: number; body: string; mac: string };

/** The app's end of one authenticated connection. */
export class LinkSession {
  private sent = 0;
  private received = 0;

  constructor(private readonly key: Uint8Array) {}

  /** Sign and number a message for the rover. The body is sent as an exact string. */
  seal(payload: Record<string, unknown>): Envelope {
    this.sent += 1;
    const body = JSON.stringify(payload);
    return { seq: this.sent, body, mac: hmacHex(this.key, `${CLIENT_TO_ROVER}|${this.sent}|${body}`) };
  }

  /** Check and unwrap a message from the rover. Null if forged, replayed or malformed. */
  open(envelope: unknown): Record<string, unknown> | null {
    if (typeof envelope !== "object" || envelope === null) return null;
    const { seq, body, mac } = envelope as Partial<Envelope>;
    if (typeof seq !== "number" || !Number.isInteger(seq) || typeof body !== "string" || typeof mac !== "string") return null;
    if (!sameMac(mac, hmacHex(this.key, `${ROVER_TO_CLIENT}|${seq}|${body}`))) return null;
    // Strictly increasing, so a replayed or reordered packet is dropped.
    if (seq <= this.received) return null;
    this.received = seq;
    try {
      const payload = JSON.parse(body);
      return typeof payload === "object" && payload !== null ? payload : null;
    } catch {
      return null;
    }
  }
}
