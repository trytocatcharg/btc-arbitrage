import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export function selectorHash(value: string): Uint8Array {
  return keccakBytes(new TextEncoder().encode(value));
}

export function typeHash(value: string): Uint8Array {
  return selectorHash(value);
}

export function hashString(value: string): Uint8Array {
  return keccakBytes(new TextEncoder().encode(value));
}

export function keccakBytes(value: Uint8Array): Uint8Array {
  return keccak_256(value);
}

export function abiWord(value: number | bigint): Uint8Array {
  const bigint = BigInt(value);
  if (bigint < 0n) throw new Error('Cannot ABI-encode negative unsigned integer');
  return bigintToBytes(bigint, 32);
}

export function abiSignedWord(value: bigint): Uint8Array {
  const max = 1n << 256n;
  const normalized = value < 0n ? max + value : value;
  if (normalized < 0n || normalized >= max) throw new Error('Signed value does not fit int256');
  return bigintToBytes(normalized, 32);
}

export function bytes32Word(value: Uint8Array): Uint8Array {
  if (value.length !== 32) throw new Error('Expected bytes32 value');
  return value;
}

export function addressWord(value: string): Uint8Array {
  return concatBytes(new Uint8Array(12), hexToBytes(normalizeAddress(value).slice(2)));
}

export function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let current = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) throw new Error(`Value ${value} does not fit in ${length} bytes`);
  return bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function normalizePrivateKey(privateKey: string): string {
  const value = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('Expected a 32-byte hex private key');
  return value;
}

export function normalizeAddress(address: string): string {
  const value = address.startsWith('0x') ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid Ethereum address: ${address}`);
  return `0x${value.toLowerCase()}`;
}

export function privateKeyToAddress(privateKey: string): string {
  const publicKey = secp256k1.getPublicKey(hexToBytes(normalizePrivateKey(privateKey)), false);
  return `0x${bytesToHex(keccakBytes(publicKey.slice(1)).slice(-20))}`;
}

export function signDigestToCompactBase64(digest: Uint8Array, privateKey: string): string {
  const signature = secp256k1.sign(digest, hexToBytes(normalizePrivateKey(privateKey)));
  const r = bigintToBytes(signature.r, 32);
  const s = bigintToBytes(signature.s, 32);
  if (signature.recovery === 1) s[0] |= 0x80;
  return Buffer.from(concatBytes(r, s)).toString('base64');
}

export function signDigestToRpcHex(digest: Uint8Array, privateKey: string): string {
  const signature = secp256k1.sign(digest, hexToBytes(normalizePrivateKey(privateKey)));
  const r = bigintToBytes(signature.r, 32);
  const s = bigintToBytes(signature.s, 32);
  const v = Uint8Array.of(signature.recovery + 27);
  return `0x${bytesToHex(concatBytes(r, s, v))}`;
}
