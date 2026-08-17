import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { BackendConfig } from '../config.js';
import { JsonHttpClient } from './http-client.js';

const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const LOGIN_TYPE = 'Login(address account,uint256 nonce,uint32 deadline)';
const ACCESS_TOKEN_SKEW_SECONDS = 30;
const LOGIN_MESSAGE_TTL_SECONDS = 5 * 60;

interface RisexAuthDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtSeconds: number;
}

export class RisexJwtAuthProvider {
  private cachedToken?: CachedToken;
  private loginPromise?: Promise<string>;

  constructor(
    private readonly client: JsonHttpClient,
    private readonly config: BackendConfig['risex']
  ) {}

  async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAtSeconds - ACCESS_TOKEN_SKEW_SECONDS > nowSeconds) {
      console.log('RISEx auth using cached JWT', {
        account: redactAddress(this.config.accountAddress),
        expiresAtSeconds: this.cachedToken.expiresAtSeconds
      });
      return this.cachedToken.accessToken;
    }

    if (this.loginPromise) {
      console.log('RISEx auth awaiting in-flight JWT login', {
        account: redactAddress(this.config.accountAddress)
      });
      return this.loginPromise;
    }

    console.log('RISEx auth refreshing JWT', {
      account: redactAddress(this.config.accountAddress)
    });

    this.loginPromise = this.login()
      .then((accessToken) => {
        this.cachedToken = {
          accessToken,
          expiresAtSeconds: extractJwtExpiry(accessToken) ?? (nowSeconds + LOGIN_MESSAGE_TTL_SECONDS)
        };
        console.log('RISEx auth JWT acquired', {
          account: redactAddress(this.config.accountAddress),
          expiresAtSeconds: this.cachedToken.expiresAtSeconds
        });
        return accessToken;
      })
      .finally(() => {
        this.loginPromise = undefined;
      });

    return this.loginPromise;
  }

  private async login(): Promise<string> {
    const account = this.requireAccountAddress();
    const privateKey = this.requireAccountPrivateKey();
    ensureAccountMatchesPrivateKey(account, privateKey);

    console.log('RISEx auth login starting', {
      account: redactAddress(account)
    });

    const [domainPayload, noncePayload] = await Promise.all([
      this.client.get('/v1/auth/eip712-domain'),
      this.client.get('/v1/auth/nonce', { query: { account } })
    ]);

    const domain = parseAuthDomain(domainPayload);
    const nonceHex = parseLoginNonce(noncePayload);
    const deadline = Math.floor(Date.now() / 1000) + LOGIN_MESSAGE_TTL_SECONDS;
    console.log('RISEx auth login challenge loaded', {
      account: redactAddress(account),
      domainName: domain.name,
      domainVersion: domain.version,
      chainId: domain.chainId.toString(),
      verifyingContract: redactAddress(domain.verifyingContract),
      nonce: nonceHex,
      deadline
    });
    const signature = signLoginTypedData({
      privateKey,
      domain,
      account,
      nonceHex,
      deadline
    });
    console.log('RISEx auth login signature built', {
      account: redactAddress(account),
      signatureLength: signature.length,
      signaturePrefix: signature.slice(0, 10),
      signatureSuffix: signature.slice(-10)
    });

    const payload = await this.client.post('/v1/auth/login', {
      body: {
        account,
        nonce: nonceHex,
        deadline,
        signature
      }
    });

    console.log('RISEx auth login response received', {
      account: redactAddress(account),
      payloadKeys: listObjectKeys(payload)
    });

    return extractAccessToken(payload);
  }

  private requireAccountAddress(): string {
    if (!this.config.accountAddress) throw new Error('RISEX_ACCOUNT_ADDRESS is required for RISEx authenticated reads');
    return this.config.accountAddress;
  }

  private requireAccountPrivateKey(): string {
    if (!this.config.accountPrivateKey) {
      throw new Error('RISEX_ACCOUNT_PRIVATE_KEY is required for RISEx JWT login on authenticated reads');
    }
    return this.config.accountPrivateKey;
  }
}

function parseAuthDomain(payload: unknown): RisexAuthDomain {
  const body = unwrapData(payload);
  if (!isRecord(body)) throw new Error('RISEx auth domain response was not an object');
  const name = stringField(body, ['name']);
  const version = stringField(body, ['version']);
  const chainId = stringField(body, ['chain_id', 'chainId']);
  const verifyingContract = stringField(body, ['verifying_contract', 'verifyingContract']);
  if (!name || !version || !chainId || !verifyingContract) {
    throw new Error('RISEx auth domain response is missing required fields');
  }
  return {
    name,
    version,
    chainId: BigInt(chainId),
    verifyingContract: normalizeAddress(verifyingContract)
  };
}

function parseLoginNonce(payload: unknown): string {
  const body = unwrapData(payload);
  if (!isRecord(body)) throw new Error('RISEx login nonce response was not an object');
  const nonce = stringField(body, ['nonce']);
  if (!nonce) throw new Error('RISEx login nonce response is missing nonce');
  return normalizeHexValue(nonce);
}

function signLoginTypedData(input: {
  privateKey: string;
  domain: RisexAuthDomain;
  account: string;
  nonceHex: string;
  deadline: number;
}): string {
  const digest = createLoginDigest(input);
  const signature = secp256k1.sign(digest, hexToBytes(normalizePrivateKey(input.privateKey)));
  const r = bigintToBytes(signature.r, 32);
  const s = bigintToBytes(signature.s, 32);
  const v = Uint8Array.of(signature.recovery + 27);
  return `0x${bytesToHex(concatBytes(r, s, v))}`;
}

function createLoginDigest(input: {
  domain: RisexAuthDomain;
  account: string;
  nonceHex: string;
  deadline: number;
}): Uint8Array {
  const domainSeparator = keccakBytes(concatBytes(
    typeHash(EIP712_DOMAIN_TYPE),
    hashString(input.domain.name),
    hashString(input.domain.version),
    abiWord(input.domain.chainId),
    addressWord(input.domain.verifyingContract)
  ));
  const structHash = keccakBytes(concatBytes(
    typeHash(LOGIN_TYPE),
    addressWord(input.account),
    abiWord(BigInt(input.nonceHex)),
    abiWord(input.deadline)
  ));
  return keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash));
}

function extractAccessToken(payload: unknown): string {
  const candidates = [
    ['access_token'],
    ['accessToken'],
    ['token'],
    ['data', 'access_token'],
    ['data', 'accessToken'],
    ['data', 'token'],
    ['data', 'tokens', 'access_token'],
    ['data', 'tokens', 'accessToken'],
    ['tokens', 'access_token'],
    ['tokens', 'accessToken']
  ];

  for (const path of candidates) {
    const value = getPath(payload, path);
    if (typeof value === 'string' && value.length > 0) return value;
  }

  throw new Error('RISEx auth login response did not include an access token');
}

function extractJwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), 'base64').toString('utf8')) as Record<string, unknown>;
    const exp = json.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

function ensureAccountMatchesPrivateKey(account: string, privateKey: string): void {
  if (normalizeAddress(account) !== privateKeyToAddress(privateKey)) {
    throw new Error('RISEX_ACCOUNT_PRIVATE_KEY does not match RISEX_ACCOUNT_ADDRESS');
  }
}

function base64UrlToBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return `${normalized}${'='.repeat(padLength)}`;
}

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current) || !('data' in current)) return current;
    current = current.data;
  }
  return current;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typeHash(value: string): Uint8Array {
  return keccakBytes(new TextEncoder().encode(value));
}

function hashString(value: string): Uint8Array {
  return keccakBytes(new TextEncoder().encode(value));
}

function keccakBytes(value: Uint8Array): Uint8Array {
  return keccak_256(value);
}

function abiWord(value: number | bigint): Uint8Array {
  const bigint = BigInt(value);
  if (bigint < 0n) throw new Error('Cannot ABI-encode negative unsigned integer');
  return bigintToBytes(bigint, 32);
}

function addressWord(value: string): Uint8Array {
  return concatBytes(new Uint8Array(12), hexToBytes(normalizeAddress(value).slice(2)));
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let current = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) throw new Error(`Value ${value} does not fit in ${length} bytes`);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePrivateKey(privateKey: string): string {
  const value = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('RISEX_ACCOUNT_PRIVATE_KEY must be a 32-byte hex private key');
  return value;
}

function privateKeyToAddress(privateKey: string): string {
  const publicKey = secp256k1.getPublicKey(hexToBytes(normalizePrivateKey(privateKey)), false);
  return `0x${bytesToHex(keccakBytes(publicKey.slice(1)).slice(-20))}`;
}

function normalizeAddress(address: string): string {
  const value = address.startsWith('0x') ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid Ethereum address: ${address}`);
  return `0x${value.toLowerCase()}`;
}

function normalizeHexValue(value: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(normalized)) throw new Error(`Invalid hex value: ${value}`);
  return normalized.toLowerCase();
}

function redactAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function listObjectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).slice(0, 20) : [];
}
