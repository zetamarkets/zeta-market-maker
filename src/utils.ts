import {
  assets,
  Exchange,
  constants,
  Client,
  utils,
  instructions,
} from "@zetamarkets/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { MARKET_INDEXES } from "./constants";

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

// generates ids based on current timestamp.
// assumes only 1 creator to exist at the time, and the rate of id generation to be > 1/ms
// based on Atomics: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/add
export function idCreator(start?: number): () => number {
  const buffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const uint32 = new BigInt64Array(buffer);
  uint32[0] = BigInt(start ?? Date.now());
  function createId(): number {
    return Number(Atomics.add(uint32, 0, 1n));
  }
  return createId;
}
