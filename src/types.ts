import { constants } from "@zetamarkets/sdk";

export enum MarketIndex {
  FUT1 = 22,
  FUT2 = 45,
  PERP = constants.PERP_INDEX,
}

export interface Level {
  price: number;
  size: number;
}

export interface TopLevel {
  bid: Level;
  ask: Level;
}

export interface TopLevelMsg {
  assetName: string;
  asset: constants.Asset;
  topLevel: TopLevel;
  timestamp: number;
}

export interface Spread {
  bid: number;
  ask: number;
}

export interface Quote {
  asset: constants.Asset;
  marketIndex: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

export interface Theo {
  theo: number;
  topBid: Level;
  topAsk: Level;
  timestamp: number;
}
