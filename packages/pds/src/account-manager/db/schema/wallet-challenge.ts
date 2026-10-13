/**
 * A pending Krao wallet sign-in challenge. `account` is the normalized CAIP-10
 * id of the wallet the challenge was issued to.
 */
export interface WalletChallenge {
  nonce: string
  account: string
  expiresAt: string
}

export const tableName = 'wallet_challenge'

export type PartialDB = { [tableName]: WalletChallenge }
