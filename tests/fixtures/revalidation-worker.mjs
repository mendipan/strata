import {parentPort,workerData} from 'node:worker_threads';
if(workerData.mode==='timeout'){setInterval(()=>{},100);await new Promise(()=>{});}
else if(workerData.mode==='crash')throw new Error('Synthetic worker crash');
else if(workerData.mode==='ipc')parentPort.postMessage({large:'x'.repeat(262145)});
else if(workerData.mode==='interrupt'){parentPort.postMessage({ready:true});await new Promise(()=>{});}
else parentPort.postMessage({ok:true});
