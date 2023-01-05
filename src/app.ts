#!ts-node

// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import { loadConfig } from "./configuration";
import { schedule } from "./utils";
import { log } from "./log";
import { Maker } from "./maker";
import { assets } from "@zetamarkets/sdk";

async function main() {
  const config = loadConfig();
  const allAssets = Array.from(config.assets.keys());
  const maker = new Maker(config);
  await maker.initialize();

  const die = async (reason: string) => {
    log.info(`Shutting down due to ${reason}`);
    await maker.shutdown();
    process.exit(1);
  };
  log.info(
    `...kicking off stale price check at interval ${config.markPriceStaleIntervalMs}ms`
  );
  schedule(async () => {
    const now = Date.now();
    const staleTheosTs = allAssets
      .map((asset): [assets.Asset, number, number] => [
        asset,
        maker.getTheo(asset)?.timestamp,
        now - maker.getTheo(asset)?.timestamp,
      ])
      .filter(([_1, _2, age]) => age > config.markPriceStaleIntervalMs);
    if (staleTheosTs.length > 0)
      await die(
        `stale mark prices
${staleTheosTs
  .map(
    ([asset, ts, age]) =>
      `- ${asset}, lastUpdated: ${new Date(ts).toLocaleString()}, age: ${age}ms`
  )
  .join(`\n`)}`
      );
  }, config.markPriceStaleIntervalMs);

  process.on("SIGINT", async () => {
    await die("SIGINT");
  });
  process.on("SIGTERM", async () => {
    await die("SIGTERM");
  });
}

main();
