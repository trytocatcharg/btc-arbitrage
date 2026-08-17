import { REGISTER_SIGNER_MESSAGE } from './domain.js';
import { addressWord, abiWord, concatBytes, hashString, keccakBytes, signDigestToRpcHex } from './helpers.js';
import type { Eip712Domain } from '../types/config.js';
import type { NonceState } from '../types/auth.js';

const DEFAULT_SIGNER_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const REGISTER_SIGNER_TYPE = 'RegisterSigner(address account,address signer,string message,uint32 expiration,uint48 nonceAnchor,uint8 nonceBitmap)';
const VERIFY_SIGNER_TYPE = 'VerifySigner(address account,uint48 nonceAnchor,uint8 nonceBitmap)';

export interface RegisterSignerSignatures {
  accountSignature: string;
  signerSignature: string;
  nonceAnchor: number;
  nonceBitmapIndex: number;
  expiration: number;
  message: string;
}

export async function createRegisterSignerSignatures(
  accountPrivateKey: string,
  accountAddress: string,
  signerPrivateKey: string,
  signerAddress: string,
  domain: Eip712Domain,
  nonceState: NonceState,
  expirationSeconds?: number
): Promise<RegisterSignerSignatures> {
  const expiration = Math.floor(Date.now() / 1000) + (expirationSeconds ?? DEFAULT_SIGNER_EXPIRY_SECONDS);
  const nonceAnchor = Number(nonceState.nonce_anchor) + 1;
  const nonceBitmapIndex = 0;
  const message = REGISTER_SIGNER_MESSAGE;
  const domainSeparator = keccakBytes(concatBytes(
    hashString(EIP712_DOMAIN_TYPE),
    hashString(domain.name),
    hashString(domain.version),
    abiWord(domain.chainId),
    addressWord(domain.verifyingContract)
  ));

  const registerStructHash = keccakBytes(concatBytes(
    hashString(REGISTER_SIGNER_TYPE),
    addressWord(accountAddress),
    addressWord(signerAddress),
    hashString(message),
    abiWord(expiration),
    abiWord(nonceAnchor),
    abiWord(nonceBitmapIndex)
  ));
  const verifyStructHash = keccakBytes(concatBytes(
    hashString(VERIFY_SIGNER_TYPE),
    addressWord(accountAddress),
    abiWord(nonceAnchor),
    abiWord(nonceBitmapIndex)
  ));

  const accountDigest = keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, registerStructHash));
  const signerDigest = keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, verifyStructHash));

  return {
    accountSignature: signDigestToRpcHex(accountDigest, accountPrivateKey),
    signerSignature: signDigestToRpcHex(signerDigest, signerPrivateKey),
    nonceAnchor,
    nonceBitmapIndex,
    expiration,
    message
  };
}
