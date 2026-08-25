import { createCipheriv } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function digest(algorithm: 'SHA-1' | 'SHA-256', data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data as BufferSource));
}

function concatBytes(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function rc4(key: Uint8Array, input: Uint8Array) {
  const box = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i] + key[i % key.length]) & 255;
    [box[i], box[j]] = [box[j], box[i]];
  }

  let i = 0;
  j = 0;
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length + 1024; index += 1) {
    i = (i + 1) & 255;
    j = (j + box[i]) & 255;
    [box[i], box[j]] = [box[j], box[i]];
    const value = box[(box[i] + box[j]) & 255];
    if (index >= 1024) output[index - 1024] = input[index - 1024] ^ value;
  }
  return output;
}

/**
 * xiaomi.lock.d100j derives its password key from the low 32 bits of the DID
 * and the reversed Bluetooth MAC. This mirrors generateSecretKey() and
 * aesEncryptToEcbForUtf8() in Xiaomi's official D100 plugin.
 */
export function encryptLockUserPassword(pin: string, did: string, mac: string) {
  if (!/^\d{6}$/.test(pin)) throw new Error('门锁密码必须是 6 位数字');
  if (!/^\d+$/.test(did)) throw new Error('门锁 DID 无效，无法生成密码密文');
  const macBytes = mac.replace(/[:-]/g, '').match(/../g);
  if (!macBytes || macBytes.length !== 6 || macBytes.some((byte) => !/^[\da-f]{2}$/i.test(byte))) {
    throw new Error('米家未返回门锁的蓝牙 MAC，无法安全创建用户密码');
  }

  // Bitwise conversion intentionally matches the official plugin's parseInt
  // plus shifts, which operate on the DID's low unsigned 32 bits.
  const did32 = Number(did) >>> 0;
  const bigEndian = [did32 >>> 24, did32 >>> 16 & 0xff, did32 >>> 8 & 0xff, did32 & 0xff];
  const didBytes = [bigEndian[3], bigEndian[2], bigEndian[1], bigEndian[0], ...bigEndian];
  const keyBytes: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    keyBytes.push(didBytes[index], Number.parseInt(macBytes[5 - index], 16));
  }
  keyBytes.push(didBytes[6], didBytes[7], 0xe5, 0xa5);

  const block = new Uint8Array(16);
  block.set(encoder.encode(pin));
  // ECB does not use an IV. Node accepts null, while the Workers node:crypto
  // compatibility layer expects an empty binary value instead.
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(keyBytes), Buffer.alloc(0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]).toString('base64');
}

export function generateNonce() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes.subarray(0, 8));
  const minute = Math.floor(Date.now() / 60000);
  new DataView(bytes.buffer).setUint32(8, minute, false);
  return bytesToBase64(bytes);
}

export async function signedNonce(ssecurity: string, nonce: string) {
  return bytesToBase64(await digest('SHA-256', concatBytes(base64ToBytes(ssecurity), base64ToBytes(nonce))));
}

async function signature(uri: string, method: string, nonce: string, params: Record<string, string>) {
  const values = [method.toUpperCase(), uri, ...Object.entries(params).map(([key, value]) => `${key}=${value}`), nonce];
  return bytesToBase64(await digest('SHA-1', encoder.encode(values.join('&'))));
}

export async function encryptParams(uri: string, payload: unknown, ssecurity: string) {
  const nonce = generateNonce();
  const secret = await signedNonce(ssecurity, nonce);
  const params: Record<string, string> = { data: JSON.stringify(payload) };
  params.rc4_hash__ = await signature(uri, 'POST', secret, params);
  for (const [key, value] of Object.entries(params)) {
    params[key] = bytesToBase64(rc4(base64ToBytes(secret), encoder.encode(value)));
  }
  params.signature = await signature(uri, 'POST', secret, params);
  params.ssecurity = ssecurity;
  params._nonce = nonce;
  return { params, nonce };
}

export async function decryptResponse(ssecurity: string, nonce: string, payload: string) {
  const secret = await signedNonce(ssecurity, nonce);
  const decrypted = rc4(base64ToBytes(secret), base64ToBytes(payload));
  if (decrypted[0] === 0x1f && decrypted[1] === 0x8b) {
    const stream = new Blob([decrypted as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return decoder.decode(decrypted);
}
