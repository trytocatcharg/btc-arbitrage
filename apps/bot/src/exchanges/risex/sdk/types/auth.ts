export interface PermitParams {
  account: string;
  signer: string;
  nonce_anchor: number;
  nonce_bitmap_index: number;
  deadline: number;
  signature: string;
  is_erc1271?: boolean;
}

export interface NonceState {
  nonce_anchor: string;
  current_bitmap_index: number;
}

export interface SignerInfo {
  signer: string;
  account: string;
  expiration: number;
  label?: string;
  status: number;
  [key: string]: unknown;
}

export interface SessionKeyStatus {
  status: number;
  [key: string]: unknown;
}

export interface RegisterSignerResult {
  alreadyActive?: boolean;
  [key: string]: unknown;
}
