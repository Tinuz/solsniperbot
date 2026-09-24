// Worker entry for autotuning cycles. Plain JavaScript on purpose: under tsx
// (npm run dev) it registers the TypeScript loader before importing the job,
// which --import in a worker's execArgv does not do reliably.
import { parentPort, workerData } from 'node:worker_threads'

const { module, job } = workerData
if (module.endsWith('.ts')) {
  const { register } = await import('tsx/esm/api')
  register()
}
const { runTuningJob } = await import(module)
parentPort.postMessage(await runTuningJob(job))
