import { parentPort,workerData } from 'node:worker_threads';
import { executeRecognizedCounter } from './counter-execution.js';
try{parentPort!.postMessage(await executeRecognizedCounter(workerData));}
catch{parentPort!.postMessage({ok:false});}
