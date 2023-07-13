import { constants } from "@zetamarkets/sdk";

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
