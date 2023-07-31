import { loadConfig } from "./configuration";
import { pro } from "ccxt";

async function main() {
  const config = loadConfig();
  let hedgeExchange = new pro[config.hedgeExchange](
    config.credentials[config.hedgeExchange]
  );
  let hedgeOb = await hedgeExchange.watchOrderBook("SOL/USDT:USDT");
  console.log(hedgeOb);

  let balance = await hedgeExchange.fetchBalance({
    coin: "USDT",
  });

  console.log(balance.info.result);
}

main();
