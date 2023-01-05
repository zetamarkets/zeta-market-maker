import {
  assets,
  Exchange,
  constants,
  Client,
  utils,
  instructions,
} from "@zetamarkets/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BPS_FACTOR, MARKET_INDEXES } from "./constants";
import { log } from "./log";

export async function initializeClientState(
  zetaClient: Client,
  usedAssets: assets.Asset[]
) {
  for (var a of usedAssets) {
    let sub = zetaClient.getSubClient(a);

    if (sub.marginAccount === null) {
      log.info(`User has no margin account, creating`);
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
        log.debug(
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

export function schedule(closure: () => void, interval: number): NodeJS.Timer {
  // call first time
  (async () => {
    closure();
  })();
  // schedule subsequent
  return setInterval(closure, interval);
}

export function diffInBps(x, y: number): number {
  let diff = Math.abs(x - y);
  return (diff / y) * BPS_FACTOR;
}

export function groupBy<T, K>(ts: T[], getKey: (t: T) => K): [K, T[]][] {
  const grouped = new Map();
  for (var t of ts) {
    const key = getKey(t);
    let forKey = grouped.get(key);
    if (!forKey) grouped.set(key, [t]);
    else forKey.push(t);
  }
  return Array.from(grouped.entries());
}

// generates ids based on current timestamp.
// NOTE: assumes only 1 creator to exist at the time, and the rate of id generation to be > 1/ms (in case creator is re-initialized)
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
