#!/usr/bin/env node
/**
 * CI entry point (§5).
 *
 * Exits non-zero on any failure, including refused deletions — a build that
 * refused to remove documents has not converged, and a green tick would say
 * otherwise.
 */

import { runBuild } from './index.js';
import { ConfigError, loadConfig } from './config.js';
import { CloudflareKv, MemoryKv } from './kv.js';
import { CloudflareR2, MemoryR2 } from './r2.js';
import { writeSummary } from './report.js';

async function main(): Promise<number> {
  const config = loadConfig();

  const kv = config.dryRun
    ? new MemoryKv()
    : new CloudflareKv({
        accountId: config.cloudflare.accountId,
        apiToken: config.cloudflare.apiToken,
        namespaceId: config.cloudflare.kvNamespaceId,
      });

  const r2 = config.dryRun
    ? new MemoryR2()
    : new CloudflareR2({
        accountId: config.cloudflare.accountId,
        apiToken: config.cloudflare.apiToken,
        bucket: config.cloudflare.r2Bucket,
      });

  const report = await runBuild(config, { kv, r2 });
  await writeSummary(report, config.summaryPath);

  return report.refusedDeletions.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(`configuration error: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.stack ?? error.message);
      const failures = (error as { failures?: string[] }).failures;
      if (Array.isArray(failures)) for (const failure of failures) console.error(`  · ${failure}`);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  });
