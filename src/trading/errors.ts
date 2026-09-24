/** pump program error codes worth naming in logs (from the IDL). */
const PUMP_ERRORS: Record<number, string> = {
  6002: 'slippage: too much SOL required',
  6003: 'slippage: too little SOL received',
  6005: 'bonding curve complete (migrated)',
  6020: 'buy zero amount',
  6021: 'not enough tokens to buy',
  6022: 'sell zero amount',
  6023: 'not enough tokens to sell',
  6040: 'not enough SOL to cover rent',
  6041: 'not enough SOL to cover fees',
  6042: 'slippage: fewer tokens than min_tokens_out',
}

/** Turns a transaction error object into a readable string. */
export function describeTxError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err
  const ie = (err as { InstructionError?: [number, unknown] }).InstructionError
  if (ie) {
    const [index, inner] = ie
    const custom = (inner as { Custom?: number })?.Custom
    if (typeof custom === 'number') return `ix ${index}: ${PUMP_ERRORS[custom] ?? `custom error ${custom}`}`
    return `ix ${index}: ${typeof inner === 'string' ? inner : JSON.stringify(inner)}`
  }
  if (err instanceof Uint8Array) return 'transaction error'
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function isSlippageError(err: unknown): boolean {
  const custom = (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError?.[1]?.Custom
  return custom === 6002 || custom === 6003 || custom === 6042
}

export function isCurveCompleteError(err: unknown): boolean {
  return (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError?.[1]?.Custom === 6005
}
