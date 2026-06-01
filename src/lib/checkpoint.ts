// Lightweight memory + timing checkpoint logger shared between the SQP CLI
// and the SP-API call path. Used to diagnose the SQP OOM — captures rss,
// heapUsed, and external separately because the leak signatures differ:
//
//   - JS-object leak (e.g. payload kept alive) → heapUsed climbs
//   - Socket / Buffer leak (e.g. undici keep-alive, gunzip buffers) → rss
//     and / or external climb with flat heapUsed
//
// One module-level start time so deltas line up across files.

const __ckptStart = Date.now();

export function checkpoint(step: string): void {
  const m = process.memoryUsage();
  const mb = (b: number): string => (b / 1024 / 1024).toFixed(0).padStart(4);
  const dt = ((Date.now() - __ckptStart) / 1000).toFixed(1).padStart(5);
  console.log(
    `[ckpt +${dt}s] ${step.padEnd(38)} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB`,
  );
}
