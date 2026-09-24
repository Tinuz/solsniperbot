import pino, { type Logger } from 'pino'

export type { Logger }

/**
 * Structured logger. Formatting runs in pino's worker thread so the trading
 * loop never blocks on terminal output. Set LOG_FORMAT=json for raw JSON lines.
 */
export function createLogger(level: string): Logger {
  const pretty = process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  })
}
