// يبني ملف Excel خارج الخيط الرئيسي (انظر costReportXlsx في export.js)
import { parentPort, workerData } from 'node:worker_threads';
import { buildCostWorkbook } from './export.js';

try {
  const buf = await buildCostWorkbook(workerData);
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  parentPort.postMessage({ buffer: ab }, [ab]);
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
