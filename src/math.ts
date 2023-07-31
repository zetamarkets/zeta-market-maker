import { TopLevelMsg } from "./types";
import { utils } from "@zetamarkets/sdk";
import * as constants from "./constants";
import { Spread } from "./types";

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

export function calculateSpread(
  price: number,
  spreadBps: number,
  totalDeltas: number,
  maxCashDelta: number,
  leanBps: number
): Spread {
  let notionalDelta = totalDeltas * price;
  let newLean =
    notionalDelta > 0
      ? Math.max(
          (-notionalDelta / maxCashDelta) * (spreadBps + leanBps),
          -(spreadBps + leanBps)
        )
      : Math.min(
          (-notionalDelta / maxCashDelta) * (spreadBps + leanBps),
          spreadBps + leanBps
        );

  let newBidEdge = (price * (-spreadBps + newLean)) / constants.BPS_FACTOR;
  let newAskEdge = (price * (spreadBps + newLean)) / constants.BPS_FACTOR;
  let newBid = price + newBidEdge;
  let newAsk = price + newAskEdge;

  return {
    bid: newBid,
    ask: newAsk,
  };
}

export function calculateSpreadNoLean(
  price: number,
  spreadBps: number
): Spread {
  let bidEdge = (price * -spreadBps) / constants.BPS_FACTOR;
  let askEdge = (price * spreadBps) / constants.BPS_FACTOR;
  let bid = price + bidEdge;
  let ask = price + askEdge;
  return {
    bid: bid,
    ask: ask,
  };
}

export function convertPriceToOrderPrice(price: number, bid: boolean): number {
  let orderPrice = utils.convertDecimalToNativeInteger(price);
  return roundTickSize(orderPrice, bid);
}
