import {
  ComputeBudgetProgram,
  type Keypair,
  MessageV0,
  type PublicKey,
  SystemProgram,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import type { CachedBlockhash } from './blockhash.js'

export const MAX_TX_BYTES = 1232

export interface BuiltTx {
  signature: string
  base64: string
  bytes: Uint8Array
  blockhash: string
  lastValidBlockHeight: number
}

export interface BuildOptions {
  payer: Keypair
  instructions: TransactionInstruction[]
  computeUnits: number
  microLamportsPerCu: bigint
  blockhash: CachedBlockhash
  tip?: { account: PublicKey; lamports: bigint }
}

/** Compiles, signs and serializes a v0 transaction with compute budget and optional tip. */
export function buildTransaction(o: BuildOptions): BuiltTx {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnits }),
  ]
  if (o.microLamportsPerCu > 0n) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.microLamportsPerCu }))
  ixs.push(...o.instructions)
  if (o.tip && o.tip.lamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: o.payer.publicKey, toPubkey: o.tip.account, lamports: o.tip.lamports }))
  }

  const message = MessageV0.compile({
    payerKey: o.payer.publicKey,
    recentBlockhash: o.blockhash.blockhash,
    instructions: ixs,
  })
  const tx = new VersionedTransaction(message)
  tx.sign([o.payer])
  const bytes = tx.serialize()
  if (bytes.length > MAX_TX_BYTES) throw new Error(`transaction is ${bytes.length} bytes (max ${MAX_TX_BYTES})`)
  return {
    signature: bs58.encode(tx.signatures[0]!),
    base64: Buffer.from(bytes).toString('base64'),
    bytes,
    blockhash: o.blockhash.blockhash,
    lastValidBlockHeight: o.blockhash.lastValidBlockHeight,
  }
}
