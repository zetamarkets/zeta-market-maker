// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import { Wallet, Exchange, utils, CrossClient } from "@zetamarkets/sdk";
import { loadConfig } from "./configuration";
import { Connection } from "@solana/web3.js";

const REAL_DEPOSIT_AMT = 1000_000000; // fixed-point 6 d,p, == $1000 currently.

async function main() {
  const CONFIG = loadConfig();

  const connection = new Connection(CONFIG.endpoint, "processed");
  const wallet = new Wallet(CONFIG.makerWallet);

  await Exchange.load({
    network: CONFIG.network,
    connection,
    opts: utils.defaultCommitment(),
    throttleMs: 0,
    loadFromStore: true,
  });

  Exchange.toggleAutoPriorityFee();

  const zetaCrossClient = await CrossClient.load(connection, wallet);

  await zetaCrossClient.deposit(REAL_DEPOSIT_AMT);

  await Exchange.close();
  await zetaCrossClient.close();
}

main();
