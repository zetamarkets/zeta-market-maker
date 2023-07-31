import {
  assets,
  Exchange,
  constants,
  CrossClient,
  types,
} from "@zetamarkets/sdk";
import { PublicKey } from "@solana/web3.js";
import { BPS_FACTOR } from "./constants";
import { log } from "./log";
import { MarketIndex, RiskStats } from "./types";
import fs from "fs";
import { parse } from "csv-parse";
import { finished } from "stream/promises";

export async function initializeClientState(zetaClient: CrossClient) {
  if (!zetaClient.account) {
    throw Error("cross margin account doesn't exist");
  }

  for (let i = 0; i < zetaClient.openOrdersAccounts.length; i++) {
    if (zetaClient.openOrdersAccounts[i].equals(PublicKey.default)) {
      log.debug(
        `Creating open orders account for ${assets.indexToAsset(
          i
        )} : Index: ${i}`
      );

      await zetaClient.initializeOpenOrdersAccount(assets.indexToAsset(i));
    }
  }
}

export function marketIndexToName(
  asset: constants.Asset,
  index: number
): string {
  if (index == constants.PERP_INDEX) {
    return "PERP";
  }
}

export function toDDMMMYY(date: Date): string {
  const months = [
    `JAN`,
    `FEB`,
    `MAR`,
    `APR`,
    `MAY`,
    `JUN`,
    `JUL`,
    `AUG`,
    `SEP`,
    `OCT`,
    `NOV`,
    `DEC`,
  ];
  let dd = date.getDate() >= 10 ? `${date.getDate()}` : `0${date.getDate()}`;
  let mmm = months[date.getMonth()];
  let yy = `${date.getFullYear()}`.slice(2);
  return `${dd}${mmm}${yy}`;
}

export function isValidVenue(asStr: string): boolean {
  return asStr == "zeta" || asStr == "hedge";
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

export function unique<T>(ts: T[]): T[] {
  return Array.from(new Set(ts));
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

export function emptyRiskStats(): RiskStats {
  return {
    balance: 0,
    margin: 0,
    availableBalance: 0,
    pnl: 0,
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// helper for getting description of product based on asset & marketIndex
export function instrumentDescription(
  asset: constants.Asset,
  index?: number
): string {
  if (index == undefined) {
    return asset;
  } else {
    return `${asset} PERP`;
  }
}

export function marketIndexShortDescription(index: MarketIndex): string {
  return index == MarketIndex.PERP ? "PERP" : undefined;
}

export function toFixed(x: number, fractionDigits: number): string {
  if (x != undefined) {
    const fixed = x.toFixed(fractionDigits);
    const asStr = fractionDigits < 1 ? fixed : fixed.replace(/\.*0+$/, "");
    return asStr == "-0" ? "0" : asStr; // happens when rounded down to 0, but is small negative fraction
  }
}

export function capFirst(str: string): string {
  if (str && str.length > 0) return str.charAt(0).toUpperCase() + str.slice(1);
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

export function bumpRestartCount(): number {
  const restartsCntFilename = "restart-cnt.txt";
  let restartCnt = 0;
  try {
    restartCnt = +fs.readFileSync(restartsCntFilename);
  } catch (e) {}
  restartCnt += 1;
  fs.writeFileSync(restartsCntFilename, "" + restartCnt);
  return restartCnt;
}

interface BalanceCSV {
  unixTs: number;
  balance: number;
}

export async function readCSV(filename: string): Promise<BalanceCSV[]> {
  const fc = fs.readFileSync(filename);
  const headers = ["unixTs", "balance"];

  let csvContents: BalanceCSV[] = [];
  await finished(
    parse(
      fc,
      {
        delimiter: ",",
        columns: headers,
      },
      (error, result: BalanceCSV[]) => {
        if (error) {
          throw error;
        }

        csvContents = result;
      }
    )
  );
  return csvContents.slice(1);
}

export async function appendToCSV(filename: string, balance: string) {
  fs.appendFileSync(filename, `${Math.round(Date.now() / 1000)}, ${balance}\n`);
}

export function convertToReadableOrders(
  m: Map<constants.Asset, types.Order[]>
): any {
  let readableObj: any = {};
  for (let [asset, orders] of m) {
    let readableOrders = [];
    for (let i = 0; i < orders.length; i++) {
      readableOrders.push({
        price: orders[i].price,
        size: orders[i].size,
        side: orders[i].side == types.Side.BID ? "bid" : "ask",
      });
    }
    readableObj[assets.assetToName(asset)] = readableOrders;
  }
  return readableObj;
}
