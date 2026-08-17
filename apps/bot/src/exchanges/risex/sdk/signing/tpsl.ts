import { abiWord, addressWord, concatBytes, hashString, keccakBytes, signDigestToCompactBase64, signDigestToRpcHex } from './helpers.js';
import type { Eip712Domain } from '../types/config.js';

const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const PERMIT_SINGLE_TYPE = 'PermitSingle(address account,address operator,uint96 budget,uint32 allowanceExpiry,uint48 nonceAnchor,uint8 nonceBitmap)';
const PLACE_TPSL_TYPE = 'PlaceTpslOrder(address account,uint64 marketId,uint8 side,string size,uint8 stopType,string stopPrice,string limitPrice,uint8 orderType,uint8 stopPriceOption,uint8 tif,uint32 deadline)';
const CANCEL_TPSL_TYPE = 'CancelTpslOrder(address account,string orderId,uint32 deadline)';

export function signPermitSingle(input: {
  privateKey: string;
  domain: Eip712Domain;
  account: string;
  operator: string;
  budget: bigint;
  allowanceExpiry: number;
  nonceAnchor: number;
  nonceBitmap: number;
}): string {
  const digest = createTypedDigest(input.domain, keccakBytes(concatBytes(
    hashString(PERMIT_SINGLE_TYPE),
    addressWord(input.account),
    addressWord(input.operator),
    abiWord(input.budget),
    abiWord(input.allowanceExpiry),
    abiWord(input.nonceAnchor),
    abiWord(input.nonceBitmap)
  )));
  return signDigestToRpcHex(digest, input.privateKey);
}

export function signPlaceTpsl(input: {
  privateKey: string;
  domain: Eip712Domain;
  account: string;
  marketId: number;
  side: number;
  size: string;
  stopType: number;
  stopPrice: string;
  limitPrice: string;
  orderType: number;
  stopPriceOption: number;
  tif: number;
  deadline: number;
}): string {
  const digest = createTypedDigest(input.domain, keccakBytes(concatBytes(
    hashString(PLACE_TPSL_TYPE),
    addressWord(input.account),
    abiWord(input.marketId),
    abiWord(input.side),
    hashString(input.size),
    abiWord(input.stopType),
    hashString(input.stopPrice),
    hashString(input.limitPrice),
    abiWord(input.orderType),
    abiWord(input.stopPriceOption),
    abiWord(input.tif),
    abiWord(input.deadline)
  )));
  return signDigestToCompactBase64(digest, input.privateKey);
}

export function signCancelTpsl(input: {
  privateKey: string;
  domain: Eip712Domain;
  account: string;
  orderId: string;
  deadline: number;
}): string {
  const digest = createTypedDigest(input.domain, keccakBytes(concatBytes(
    hashString(CANCEL_TPSL_TYPE),
    addressWord(input.account),
    hashString(input.orderId),
    abiWord(input.deadline)
  )));
  return signDigestToCompactBase64(digest, input.privateKey);
}

function createTypedDigest(domain: Eip712Domain, structHash: Uint8Array): Uint8Array {
  const domainSeparator = keccakBytes(concatBytes(
    hashString(EIP712_DOMAIN_TYPE),
    hashString(domain.name),
    hashString(domain.version),
    abiWord(domain.chainId),
    addressWord(domain.verifyingContract)
  ));
  return keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash));
}
