#!ts-node

// Starts the MM process, shuts down on stale prices.

import { loadConfig } from "./configuration";
import { Maker } from "./maker";

require("log-timestamp")(function () {
  return `[${new Date().toUTCString()}]`;
});

async function main() {
  const config = loadConfig();
  const allAssets = Array.from(config.assets.keys());
  const maker = new Maker(config);
  await maker.initialize();

  const die = async (reason: string) => {
    console.log(`Shutting down due to ${reason}`);
    await maker.shutdown();
    process.exit(1);
  };

  // periodic stale price check
  setInterval(async () => {
    const now = Date.now();
    const staleTheo = allAssets.find(
      (asset) =>
        now - maker.getTheo(asset)?.timestamp > config.markPriceStaleIntervalMs
    );
    if (staleTheo) await die(`stale mark prices`);
  }, config.markPriceStaleIntervalMs);

  process.on("SIGINT", async () => {
    await die("SIGINT");
  });
  process.on("SIGTERM", async () => {
    await die("SIGTERM");
  });
}

main();
