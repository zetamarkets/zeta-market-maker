#!ts-node

// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import { loadConfig } from "./configuration";
import { bumpRestartCount, schedule } from "./utils";
import { startExpress } from "./webserver";
import { log } from "./log";
import { Maker } from "./maker";
import { constants } from "@zetamarkets/sdk";

async function main() {
  const config = loadConfig();
  log.info(`Starting maker with config:
• network:                   ${config.network}
• endpoint:                  ${config.endpoint}
• programId:                 ${config.programId}
• walletPubkey:              ${config.makerWallet.publicKey.toString()}
• hedgeExchange:             ${config.hedgeExchange}
• quoteIntervalMs:           ${config.quoteIntervalMs}
• markPriceStaleIntervalMs:  ${config.markPriceStaleIntervalMs}
• positionRefreshIntervalMs: ${config.positionRefreshIntervalMs}
• riskStatsFetchIntervalMs:  ${config.riskStatsFetchIntervalMs}
• tifExpiryOffsetMs:         ${config.tifExpiryOffsetMs}
• lockingIntervalMs:         ${config.lockingIntervalMs}
• cashDeltaHedgeThreshold:   ${config.cashDeltaHedgeThreshold}
• webServerPort:             ${config.webServerPort}
• assets:                    ${Array.from(config.assets.entries())
    .map(
      ([asset, assetConfig]) => `
  • ${asset}:
    • maxZetaCashExposure:   ${assetConfig.maxZetaCashExposure}
    • maxNetCashDelta:       ${assetConfig.maxNetCashDelta}
    • quoteLotSize:          ${assetConfig.quoteLotSize}
    • requoteBps:            ${assetConfig.requoteBps}
    • widthBps:              ${assetConfig.widthBps}
    • instruments:           ${assetConfig.instruments
      .map(
        (instrument) => `
      • marketIndex:         ${instrument.marketIndex}
      • levels:              ${instrument.levels
        .map(
          ({ priceIncr, quoteCashDelta }) =>
            `{priceIncr: ${priceIncr}, quoteCashDelta: ${quoteCashDelta}}`
        )
        .join()}`
      )
      .join()}`
    )
    .join()}`);
  const allAssets = Array.from(config.assets.keys());

  const maker = new Maker(config);
  await maker.initialize();

  const die = async (reason: string) => {
    log.info(`Shutting down due to ${reason}`);
    await maker.shutdown();
    process.exit(1);
  };
  schedule(async () => {
    const now = Date.now();
    const theosTs = allAssets.map(
      (asset): [constants.Asset, number, number] => [
        asset,
        maker.getTheo(asset)?.timestamp,
        now - maker.getTheo(asset)?.timestamp,
      ]
    );
    const staleTheosTs = theosTs.filter(
      ([_1, _2, age]) => age > config.markPriceStaleIntervalMs
    );
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
    else
      log.debug(
        `stale mark price check success: ${theosTs.map(([asset, _, age]) =>
          JSON.stringify({ asset, age })
        )}`
      );
  }, config.markPriceStaleIntervalMs);

  const restartCnt = bumpRestartCount();
  startExpress(
    config.webServerPort,
    config.cashDeltaHedgeThreshold,
    allAssets,
    config.network,
    restartCnt,
    maker
  );

  process.on("SIGINT", async () => {
    await die("SIGINT");
  });
  process.on("SIGTERM", async () => {
    await die("SIGTERM");
  });
}

main();
