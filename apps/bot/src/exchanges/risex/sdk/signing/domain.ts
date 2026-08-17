export const REGISTER_SIGNER_TYPES = {
  RegisterSigner: [
    { name: 'account', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'message', type: 'string' },
    { name: 'expiration', type: 'uint32' },
    { name: 'nonceAnchor', type: 'uint48' },
    { name: 'nonceBitmap', type: 'uint8' }
  ]
} as const;

export const VERIFY_SIGNER_TYPES = {
  VerifySigner: [
    { name: 'account', type: 'address' },
    { name: 'nonceAnchor', type: 'uint48' },
    { name: 'nonceBitmap', type: 'uint8' }
  ]
} as const;

export const REVOKE_SIGNER_TYPES = {
  RevokeSigner: [
    { name: 'account', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'nonceAnchor', type: 'uint48' },
    { name: 'nonceBitmap', type: 'uint8' }
  ]
} as const;

export const VERIFY_WITNESS_TYPES = {
  VerifyWitness: [
    { name: 'account', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'hash', type: 'bytes32' },
    { name: 'nonceAnchor', type: 'uint48' },
    { name: 'nonceBitmap', type: 'uint8' },
    { name: 'deadline', type: 'uint32' }
  ]
} as const;

export const REGISTER_SIGNER_MESSAGE = 'Registering signer for RISEx';
