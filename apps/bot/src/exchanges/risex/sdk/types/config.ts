export interface Eip712Domain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}

export interface SystemConfig {
  addresses: {
    router?: string;
    auth?: string;
    orders_manager?: string;
    perps_manager?: string;
    collateral_manager?: string;
    usdc?: string;
    deposit?: string;
    perp_v2?: {
      orders_manager?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  contract_addresses?: {
    perps_manager?: string;
    [key: string]: unknown;
  };
  addresses_config?: {
    perp?: string;
    auth?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ClientOptions {
  baseUrl?: string;
  timeout?: number;
}

export interface ExchangeClientOptions extends ClientOptions {
  account?: string;
  accountKey?: string;
  signerKey: string;
  erc1271?: boolean;
}

export interface PermitSingleApprovalResult {
  success?: boolean;
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}
