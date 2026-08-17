import type { PermitParams, NonceState } from '../types/auth.js';
import type { Eip712Domain } from '../types/config.js';
import { addressWord, abiWord, bytes32Word, concatBytes, hashString, hexToBytes, keccakBytes, signDigestToCompactBase64 } from './helpers.js';

const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const VERIFY_WITNESS_TYPE = 'VerifyWitness(address account,address target,bytes32 hash,uint48 nonceAnchor,uint8 nonceBitmap,uint32 deadline)';
const MAX_BITMAP_INDEX = 207;

export async function createPermitParams(
  hash: string,
  signerPrivateKey: string,
  signerAddress: string,
  account: string,
  target: string,
  domain: Eip712Domain,
  nonceState: NonceState,
  deadlineSeconds?: number,
  isErc1271 = false
): Promise<PermitParams> {
  const deadline = Math.floor(Date.now() / 1000) + (deadlineSeconds ?? 300);

  let nonceAnchor = Number(nonceState.nonce_anchor);
  let nonceBitmapIndex = nonceState.current_bitmap_index;
  if (nonceBitmapIndex > MAX_BITMAP_INDEX) {
    nonceAnchor += 1;
    nonceBitmapIndex = 0;
  }

  const domainSeparator = keccakBytes(concatBytes(
    hashString(EIP712_DOMAIN_TYPE),
    hashString(domain.name),
    hashString(domain.version),
    abiWord(domain.chainId),
    addressWord(domain.verifyingContract)
  ));

  const structHash = keccakBytes(concatBytes(
    hashString(VERIFY_WITNESS_TYPE),
    addressWord(account),
    addressWord(target),
    bytes32Word(hexToBytes(hash)),
    abiWord(nonceAnchor),
    abiWord(nonceBitmapIndex),
    abiWord(deadline)
  ));

  const digest = keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash));
  const signature = signDigestToCompactBase64(digest, signerPrivateKey);

  return {
    account,
    signer: signerAddress,
    nonce_anchor: nonceAnchor,
    nonce_bitmap_index: nonceBitmapIndex,
    deadline,
    signature,
    ...(isErc1271 ? { is_erc1271: true } : {})
  };
}
