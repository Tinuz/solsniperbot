/**
 * Dutch for Telegram. The bot's logs, dashboard and reports stay English; its
 * Telegram messages are Dutch. Messages built elsewhere (autotune, vitals,
 * feeds, exit reasons) are English phrases with numbers in them, translated
 * here phrase by phrase. A phrase not listed stays English rather than being
 * lost, so a new message is never dropped, only untranslated.
 */

const STATES: Record<string, string> = { healthy: 'gezond', defensive: 'defensief', critical: 'kritiek', dead: 'dood' }

/** Longer phrases first: several are contained in others. */
const PHRASES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Starting and stopping.
  [/^💀 refuses to start: /, '💀 Start geweigerd: '],
  [/^❌ failed to start: /, '❌ Starten mislukt: '],
  [/bot is dead since (\S+): /, (_, at) => `de bot is dood sinds ${at}: `],
  [/Fund the wallet to at least (\S+ SOL) to revive it/, (_, n) => `Vul de wallet aan tot minstens ${n} om hem weer te laten handelen`],
  [/Set PAPER_RESET=true to start a new paper wallet/, 'Zet PAPER_RESET=true voor een nieuwe paper-wallet'],

  // Vitals and death.
  [/^vitals (\w+) → (\w+): /, (_, a, b) => `🩺 Gezondheid ${STATES[a] ?? a} → ${STATES[b] ?? b}: `],
  [/^bot died: /, '💀 De bot is dood: '],
  [/drawdown ([\d.]+)% from peak: trade size halved/, (_, p) => `${p}% onder de piek: inzet gehalveerd`],
  [/cannot pay the fees to exit (\d+) open position\(s\)/, (_, n) => `kan de kosten niet betalen om ${n} open positie(s) te sluiten`],
  [/too little free SOL for a new trade \(needs ([^)]+)\); waiting on (\d+) open position\(s\)/, (_, need, n) => `te weinig vrije SOL voor een nieuwe trade (nodig: ${need}); wacht op ${n} open positie(s)`],
  [/insufficient funds to trade: (\S+ SOL) left, a viable trade needs (\S+ SOL)/, (_, left, need) => `te weinig geld om te handelen: nog ${left}, een zinnige trade vraagt ${need}`],
  [/wallet is empty/, 'de wallet is leeg'],
  [/wallet balance unknown/, 'walletsaldo onbekend'],
  [/ \(transactions in flight\)/, ' (transacties onderweg)'],
  [/ \(confirming\)/, ' (wordt bevestigd)'],

  // Feeds.
  [/^⚠️ (\S+) feed: no data for (\d+)s although connected; reconnecting \(RPC credits used up, or the subscription was dropped\?\)/, (_, f, s) =>
    `⚠️ ${f}-stream: ${s} s geen data terwijl verbonden; opnieuw verbinden (RPC-credits op, of abonnement weggevallen?)`],
  [/^⚠️ (\S+) feed: subscription refused by the RPC: /, (_, f) => `⚠️ ${f}-stream: abonnement geweigerd door de RPC: `],

  // Autotune and the edge gate.
  [/^autotune cycle failed: /, '⚙️ Autotune-ronde mislukt: '],
  [/^autotune: back to \.env settings /, '⚙️ Autotune: terug naar de .env-instellingen '],
  [/^edge proven, trading enabled: /, '✅ Voordeel bewezen, de bot handelt: '],
  [/^buying paused, still recording: /, '⏸ Kopen gepauzeerd (blijft opnemen): '],
  [/^autotune: keeping /, '⚙️ Autotune behoudt '],
  [/^autotune: rolled back /, '↩️ Autotune draaide terug: '],
  [/^autotune: shadow test failed, not adopting /, '⚙️ Autotune: schaduwtest mislukt, niet overgenomen: '],
  [/^autotune exploration suggests /, '💡 Autotune (verkenning) stelt voor: '],
  [/^autotune suggests /, '💡 Autotune stelt voor: '],
  [/^autotune: shadow-testing (.+) on new launches before trading it live \((\d+) trades\)/, (_, c, n) => `⚙️ Autotune: schaduwtest van ${c} op nieuwe launches, voordat het live gaat (${n} trades)`],
  [/^autotune adopted /, '⚙️ Autotune nam over: '],
  [/; on probation for (\d+) trades/, (_, n) => `; proeftijd ${n} trades`],
  [/; trading at (\d+)% size/, (_, p) => `; handelt op ${p}% van de inzet`],
  [/after exploring ([\d.,]+) strategies/, (_, n) => `na verkenning van ${n} strategieën`],
  [/after a shadow test/, 'na een schaduwtest'],
  [/\(see ([^)]+)\)/, (_, p) => `(zie ${p})`],
  [/(\d+) trades since adoption: new (\S+ SOL) vs previous (\S+ SOL)/, (_, n, a, b) => `${n} trades sinds overname: nieuw ${a}, vorige ${b}`],
  [/no proven edge: /, 'geen bewezen voordeel: '],
  [/(\d+) recent trades made (\S+ SOL)/, (_, n, s) => `${n} recente trades maakten ${s}`],
  [/(\d+) recent trades/, (_, n) => `${n} recente trades`],
  [/collecting data: /, 'verzamelt data: '],
  [/(\d+) launches over ([\d.]+)h \(need (\d+) over (\d+)h\)/, (_, n, h, need, hNeed) => `${n} launches in ${h} u (nodig: ${need} in ${hNeed} u)`],
  [/checking whether the settings (?:in effect )?make money/, 'controleert of de instellingen winst maken'],
  [/edge check overdue/, 'controle van het voordeel te laat'],
  [/edge not required/, 'geen bewijs vereist'],
  [/makes (\S+ SOL) over (\d+) trades in the newest (\d+)% of the data, which the search never used/, (_, s, n, p) => `maakt ${s} over ${n} trades in de nieuwste ${p}% van de data, die de zoektocht nooit zag`],
  [/best candidate failed: /, 'beste kandidaat faalde op: '],
  [/\(need (\d+)\)/, (_, n) => `(nodig: ${n})`],
  [/\benough data\b/g, 'genoeg data'],
  [/\benough trades\b/g, 'genoeg trades'],
  [/\bmakes money\b/g, 'maakt winst'],
  [/\bnot one lucky trade\b/g, 'niet één geluksvoltreffer'],
  [/\bcovers its costs\b/g, 'dekt de kosten'],
  [/\bconsistent over time\b/g, 'stabiel in de tijd'],
  [/\bdrawdown in check\b/g, 'terugval beperkt'],
  [/\bprofitable out of sample\b/g, 'winstgevend op nieuwe data'],
  [/\bprofitable in validation\b/g, 'winstgevend bij validatie'],
  [/\bprofitable in test\b/g, 'winstgevend in de test'],
  [/\bwins out of sample\b/g, 'wint op nieuwe data'],

  // Exits.
  [/^free ride at \+([\d.]+)%: stake, fees and (\d+)% profit secured, (\d+)% moonbag rides/, (_, g, p, m) => `free ride op +${g}%: inleg, kosten en ${p}% winst veilig, ${m}% moonbag rijdt mee`],
  [/^moonbag trailing stop: ([\d.]+)% off peak \+([\d.]+)%/, (_, d, p) => `moonbag trailing stop: ${d}% onder de piek van +${p}%`],
  [/^trailing stop: ([\d.]+)% off peak \+([\d.]+)%/, (_, d, p) => `trailing stop: ${d}% onder de piek van +${p}%`],
  [/^moonbag stop at \+([\d.]+)%/, (_, p) => `moonbag-stop op +${p}%`],
  [/^moonbag: coin dead \(no trades for (\d+) min\)/, (_, m) => `moonbag: coin dood (${m} min geen trades)`],
  [/^moonbag: dev sold/, 'moonbag: dev verkocht'],
  [/^moonbag max hold time/, 'moonbag: maximale houdtijd'],
  [/^take profit \+([\d.]+)% \(tier (\d+)\)/, (_, g, t) => `winst genomen op +${g}% (trede ${t})`],
  [/^stop loss (-?[\d.]+)%/, (_, g) => `stop loss ${g}%`],
  [/^dev sold/, 'dev verkocht'],
  [/^max hold time/, 'maximale houdtijd'],
  [/^no trading activity/, 'geen handel meer'],
  [/^graduated to PumpSwap/, 'gegradueerd naar PumpSwap'],
  [/^manual sell-all/, 'handmatig alles verkocht'],
  [/^manual sell/, 'handmatig verkocht'],
  [/ \(tokens no longer in wallet\)/, ' (tokens niet meer in de wallet)'],
  [/^buy failed: /, 'koop mislukt: '],
  [/^daily loss limit hit \(([^)]+)\)/, (_, s) => `daglimiet voor verlies bereikt (${s})`],
  [/^dead: /, 'dood: '],
  [/^manual$/, 'handmatig'],
]

/** The Dutch version of one of the bot's English messages (unknown phrases stay as they are). */
export function toDutch(text: string): string {
  let out = text
  for (const [re, to] of PHRASES) out = out.replace(re, to as (substring: string, ...args: string[]) => string)
  return out
}

const numberFormats = new Map<number, Intl.NumberFormat>()
const format = (digits: number) => {
  let f = numberFormats.get(digits)
  if (!f) numberFormats.set(digits, (f = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits })))
  return f
}

/** `+0,0123 SOL` / `−0,0045 SOL` from lamports. */
export function solNl(lamports: bigint | number, digits = 4): string {
  const v = Number(lamports) / 1e9
  const s = format(digits).format(Math.abs(v))
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s} SOL`
}

/** `1,0234 SOL` (no sign). */
export const amountNl = (sol: number, digits = 4) => `${format(digits).format(sol)} SOL`

export const pctNl = (v: number, digits = 1, signed = true) => `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${format(digits).format(Math.abs(v))}%`

export const intNl = (v: number) => format(0).format(v)

/** `45s`, `12m`, `3u 20m`, `2d 4u`. */
export function durationNl(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}u${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}u` : ''}`
}

export const stateNl = (state: string) => STATES[state] ?? state

// Local time -----------------------------------------------------------------

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const partsFormats = new Map<string, Intl.DateTimeFormat>()

/** Offset of `timeZone` from UTC at `at`, in ms (DST included). */
function offsetMs(at: number, timeZone: string): number {
  let f = partsFormats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    partsFormats.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]))
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
  return asUtc - Math.floor(at / 1000) * 1000
}

/** Local midnight (as a UTC timestamp) of the day `at` falls in. */
export function startOfLocalDay(at: number, timeZone: string): number {
  const off = offsetMs(at, timeZone)
  return Math.floor((at + off) / DAY_MS) * DAY_MS - off
}

/** Local hour (0-23) and date (`YYYY-MM-DD`) of `at`. */
export function localClock(at: number, timeZone: string): { hour: number; day: string } {
  const local = at + offsetMs(at, timeZone)
  return { hour: Math.floor((local % DAY_MS) / HOUR_MS), day: new Date(local).toISOString().slice(0, 10) }
}

/** `25-09 14:05` in local time. */
export function dateTimeNl(at: number, timeZone: string): string {
  const d = new Date(at + offsetMs(at, timeZone)).toISOString()
  return `${d.slice(8, 10)}-${d.slice(5, 7)} ${d.slice(11, 16)}`
}
