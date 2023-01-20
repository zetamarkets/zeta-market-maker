import {
  assets,
  Exchange,
  constants,
  Client,
  utils,
  instructions,
} from "@zetamarkets/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { MarketIndex } from "./types";

export const MARKET_INDEXES = [
  MarketIndex.FUT1,
  MarketIndex.FUT2,
  MarketIndex.PERP,
];

export async function initializeClientState(
  zetaClient: Client,
  usedAssets: assets.Asset[]
) {
  for (var a of usedAssets) {
    let sub = zetaClient.getSubClient(a);

    if (sub.marginAccount === null) {
      console.log(`User has no margin account, creating`);
      let tx = new Transaction();
      tx.add(
        instructions.initializeMarginAccountIx(
          sub.subExchange.zetaGroupAddress,
          sub.marginAccountAddress,
          sub.parent.publicKey
        )
      );
      await utils.processTransaction(sub.parent.provider, tx);
    }

    for (var index of MARKET_INDEXES) {
      if (sub.openOrdersAccounts[index].equals(PublicKey.default)) {
        console.log(
          `Creating open orders account for ${assets.assetToName(
            a
          )} : Index: ${index}`
        );

        let address =
          index == constants.PERP_INDEX
            ? Exchange.getPerpMarket(a).address
            : Exchange.getMarket(a, index).address;

        await sub.initializeOpenOrdersAccount(address);
      }
    }
  }
}

export function assetToMarket(asset: assets.Asset): string {
  switch (asset) {
    case assets.Asset.BTC:
      return "BTC/USDT:USDT";
    case assets.Asset.ETH:
      return "ETH/USDT:USDT";
    case assets.Asset.SOL:
      return "SOL/USDT:USDT";
  }
}

export function stringifyArr(xs: any[]): string {
  return xs.map((x) => `\n- ${JSON.stringify(x)}`).join("");
}
