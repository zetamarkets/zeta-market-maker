import { TopLevelMsg } from "./types";
import { utils } from "@zetamarkets/sdk";
import { Spread } from "./types";

const BPS_FACTOR = 10000;

// Weighted midpoint
export function calculateFair(msg: TopLevelMsg): number {
  let pb = msg.topLevel.bid.price;
  let qb = msg.topLevel.bid.size;
  let pa = msg.topLevel.ask.price;
  let qa = msg.topLevel.ask.size;
  return (pb * qa + pa * qb) / (qa + qb);
}

export function roundTickSize(price: number, bid: boolean) {
  const tickSize = 1000;
  return bid
    ? Math.floor(price / tickSize) * tickSize
    : (Math.floor(price / tickSize) + 1) * tickSize;
}

export function roundLotSize(size: number, lotSize: number) {
  return Number((Math.floor(size / lotSize) * lotSize).toFixed(3));
}

export function calculateSpread(price: number, spreadBps: number): Spread {
  let diff = (price * spreadBps) / BPS_FACTOR;
  return {
    bid: price - diff,
    ask: price + diff,
  };
}

export function convertPriceToOrderPrice(price: number, bid: boolean): number {
  let orderPrice = utils.convertDecimalToNativeInteger(price);
  return roundTickSize(orderPrice, bid);
}

export function diffInBps(x, y: number): number {
  let diff = Math.abs(x - y);
  return (diff / y) * BPS_FACTOR;
}
