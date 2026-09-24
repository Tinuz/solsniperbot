// Copies non-TypeScript runtime assets into dist/ after `tsc`.
import { cpSync } from 'node:fs'

cpSync('src/api/dashboard.html', 'dist/api/dashboard.html')
cpSync('src/learning/tuning-worker.mjs', 'dist/learning/tuning-worker.mjs')
