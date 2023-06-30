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

export async function initializeClientState(
  zetaClient: Client,
  usedAssets: constants.Asset[]
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

    if (
      sub.openOrdersAccounts[constants.PERP_INDEX].equals(PublicKey.default)
    ) {
      console.log(`Creating open orders account for ${assets.assetToName(a)}`);
      let address = Exchange.getPerpMarket(a).address;
      await sub.initializeOpenOrdersAccount(address);
    }
  }
}

export function assetToMarket(asset: constants.Asset): string {
  switch (asset) {
    case constants.Asset.BTC:
      return "BTC/USDT:USDT";
    case constants.Asset.ETH:
      return "ETH/USDT:USDT";
    case constants.Asset.SOL:
      return "SOL/USDT:USDT";
  }
}

export function stringifyArr(xs: any[]): string {
  return xs.map((x) => `\n- ${JSON.stringify(x)}`).join("");
}
