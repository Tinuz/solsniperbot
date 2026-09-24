import { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk'
import { Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js'
import BN from 'bn.js'

/**
 * Sells on PumpSwap after a coin graduates off its bonding curve.
 *
 * Graduation is rare for sniped coins and not latency-critical, and the AMM's
 * account set has changed repeatedly, so this path deliberately uses the
 * official SDK (which fetches pool state) rather than hand-built instructions.
 */
export class AmmSeller {
  private readonly sdk: OnlinePumpAmmSdk

  constructor(rpcUrl: string) {
    this.sdk = new OnlinePumpAmmSdk(new Connection(rpcUrl, 'confirmed'))
  }

  async sellInstructions(mint: PublicKey, user: PublicKey, tokens: bigint, slippageBps: number): Promise<TransactionInstruction[]> {
    const pool = canonicalPumpPoolPda(mint)
    const state = await this.sdk.swapSolanaState(pool, user)
    return PUMP_AMM_SDK.sellBaseInput(state, new BN(tokens.toString()), slippageBps / 100)
  }
}
