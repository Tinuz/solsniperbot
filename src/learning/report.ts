import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LaunchRecord } from './record.js'
import type { Summary } from './replay.js'

/** Decision-time features plus early-flow features (first seconds after detection). */
export function features(r: LaunchRecord): Record<string, number> {
  const buyers3 = new Set<number>()
  const holdings3 = new Map<number, number>()
  let lastVt = r.curve.vt
  let net3 = 0
  let early = 0
  let sells10 = 0
  let trades10 = 0
  for (const [dt, , vt, side, lamports, wallet] of r.trades) {
    const tokens = Math.abs(lastVt - vt)
    lastVt = vt
    if (dt <= 500 && side > 0 && wallet !== 0) early += lamports
    if (dt <= 3_000) {
      if (side > 0 && wallet !== 0) buyers3.add(wallet)
      if (wallet !== 0) holdings3.set(wallet, Math.max(0, (holdings3.get(wallet) ?? 0) + side * tokens))
      net3 += side * lamports
    }
    if (dt <= 10_000) {
      trades10++
      if (side < 0) sells10++
    }
  }
  return {
    devBuySol: r.devBuyLamports / 1e9,
    devSupplyPct: (r.devBuyTokens / r.curve.supply) * 100,
    mcapSol: (r.curve.vq * r.curve.supply) / r.curve.vt / 1e9,
    creatorLaunches: r.creatorLaunches,
    nameLength: r.name.length,
    hourUtc: new Date(r.t).getUTCHours(),
    buyersFirst3s: buyers3.size,
    netSolFirst3s: net3 / 1e9,
    tradesFirst10s: trades10,
    sellsFirst10s: sells10,
    insiderBuySol: early / 1e9,
    topBuyerPct3s: (Math.max(0, ...holdings3.values()) / r.curve.supply) * 100,
  }
}

export const FEATURE_LABELS: Record<string, string> = {
  devBuySol: 'Dev buy (SOL)',
  devSupplyPct: 'Dev supply %',
  mcapSol: 'Mcap at detection (SOL)',
  creatorLaunches: 'Dev launches in window',
  nameLength: 'Name length',
  hourUtc: 'Hour (UTC)',
  buyersFirst3s: 'Buyers in first 3s',
  netSolFirst3s: 'Net SOL in first 3s',
  tradesFirst10s: 'Trades in first 10s',
  sellsFirst10s: 'Sells in first 10s',
  insiderBuySol: 'Insider buys, first 0.5s (SOL)',
  topBuyerPct3s: 'Biggest holder at 3s (% of supply, dev aside)',
}

/** Features only known this many seconds after detection: an instant buy cannot use them. */
export const LOOKAHEAD_SECONDS: Record<string, number> = {
  insiderBuySol: 0.5,
  topBuyerPct3s: 3,
  buyersFirst3s: 3,
  netSolFirst3s: 3,
  tradesFirst10s: 10,
  sellsFirst10s: 10,
}

/** Quantile bucket edges (unique, ascending) for `k` buckets. */
export function quantileEdges(values: number[], k: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const edges: number[] = []
  for (let i = 1; i < k; i++) {
    const v = sorted[Math.floor((i / k) * sorted.length)]
    if (v !== undefined && !edges.includes(v)) edges.push(v)
  }
  return edges
}

export const sol = (lamports: number) => `${lamports >= 0 ? '+' : '−'}${Math.abs(lamports / 1e9).toFixed(4)}`
export const pct = (v: number, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`
export const num = (v: number, digits = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(digits))

export function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

export function summaryRow(label: string, s: Summary): (string | number)[] {
  return [
    label,
    s.trades,
    s.trades ? `${Math.round(s.winRate * 100)}%` : '–',
    sol(s.totalPnlLamports),
    s.trades ? pct(s.meanPnlPct) : '–',
    s.trades ? pct(s.medianPnlPct) : '–',
    sol(-s.maxDrawdownLamports),
    s.trades ? `${Math.round(s.avgHoldMs / 1000)}s` : '–',
  ]
}

export const SUMMARY_HEADERS = ['', 'Trades', 'Win rate', 'Total SOL', 'Mean', 'Median', 'Max drawdown', 'Avg hold']

export function parseArgs(argv = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]!] = m[2] ?? 'true'
  }
  return out
}

export async function writeReport(dataDir: string, name: string, markdown: string): Promise<string> {
  const dir = join(dataDir, 'reports')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(':', '')
  const path = join(dir, `${name}-${stamp}.md`)
  await writeFile(path, markdown)
  return path
}
