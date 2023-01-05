import { assets } from "@zetamarkets/sdk";
import { constants } from "@zetamarkets/sdk";

export type Venue = "zeta" | "hedge";

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
  // Should really switch enum to contain string instead of number;
  assetName: string;
  asset: assets.Asset;
  topLevel: TopLevel;
  timestamp: number;
}

// Hedge exchange (bybit) specific
export function marketToAsset(market: string): assets.Asset {
  switch (market) {
    case "BTC/USDT:USDT":
      return assets.Asset.BTC;
    case "SOL/USDT:USDT":
      return assets.Asset.SOL;
    case "ETH/USDT:USDT":
      return assets.Asset.ETH;
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

// Execution
export interface Spread {
  bid: number;
  ask: number;
}

export interface Quote {
  asset: assets.Asset;
  marketIndex: number;
  level: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  bidClientOrderId: number;
  askClientOrderId: number;
}

export interface Theo {
  theo: number;
  topBid: Level;
  topAsk: Level;
  timestamp: number;
}
