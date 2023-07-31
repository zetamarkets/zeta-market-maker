import { constants, types, CrossClient } from "@zetamarkets/sdk";
import { BlockhashFetcher } from "./blockhash";
import { Exchange as ExchangePro, Order } from "ccxt";
import { Keypair } from "@solana/web3.js";

export type Venue = "zeta" | "hedge";

export enum MarketIndex {
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
  asset: constants.Asset;
  topLevel: TopLevel;
  timestamp: number;
}

interface TickerMsg {
  market: string;
  type: string;
  data: TickerData;
}

interface TickerData {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  time: number;
}

export function tickerToTopLevelMsg(data: TickerMsg): TopLevelMsg {
  return {
    assetName: data.market,
    asset: marketToAsset(data.market),
    topLevel: {
      bid: { price: data.data.bid, size: data.data.bidSize },
      ask: { price: data.data.ask, size: data.data.askSize },
    },
    timestamp: data.data.time,
  };
}

// Hedge exchange (bybit) specific
export function marketToAsset(market: string): constants.Asset {
  switch (market) {
    case "BTC/USDT:USDT":
      return constants.Asset.BTC;
    case "SOL/USDT:USDT":
      return constants.Asset.SOL;
    case "ETH/USDT:USDT":
      return constants.Asset.ETH;
    case "APT/USDT:USDT":
      return constants.Asset.APT;
    case "ARB/USDT:USDT":
      return constants.Asset.ARB;
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
    case constants.Asset.APT:
      return "APT/USDT:USDT";
    case constants.Asset.ARB:
      return "ARB/USDT:USDT";
  }
}

export function assetToBinanceMarket(asset: constants.Asset): string {
  switch (asset) {
    case constants.Asset.BTC:
      return "BTC/USDT";
    case constants.Asset.ETH:
      return "ETH/USDT";
    case constants.Asset.SOL:
      return "SOL/USDT";
    case constants.Asset.APT:
      return "APT/USDT";
    case constants.Asset.ARB:
      return "ARB/USDT";
  }
}

// Execution
export interface Spread {
  bid: number;
  ask: number;
}

export interface HedgeOrder {
  asset: constants.Asset;
  market: string;
  side: "buy" | "sell";
  price: number;
  baseAmount: number;
  clientOrderId: string;
}

export interface Quote {
  asset: constants.Asset;
  marketIndex: number;
  level: number;
  side: "bid" | "ask";
  price: number;
  size: number;
  clientOrderId: number;
}

export interface Theo {
  theo: number;
  topBid: Level;
  topAsk: Level;
  timestamp: number;
}

export interface PositionNotification {
  venue: Venue;
  asset: constants.Asset;
  marketIndex: MarketIndex;
  instrumentDescriptionShort: string;
  instrumentDescription: string;
  baseSize: number;
  cashSize: number;
  markPrice: number;
  topLevels: {
    venue: Venue;
    asset: constants.Asset;
    base: number;
    cash: number;
  }[];
}

export interface PositionNotificationAgg {
  positions: PositionNotification[];
  markPrice?: number;
  netCashDelta: number;
  netBaseDelta?: number;
}

export interface ZetaRiskStats {
  balance: number;
  marginTotal: number;
  availableBalanceTotal: number;
  pnlTotal: number;
  perAsset: Map<
    constants.Asset,
    {
      margin: number;
      pnl: number;
    }
  >;
}

export interface RiskStats {
  balance: number;
  margin: number;
  availableBalance: number;
  pnl: number;
}

export interface QuoteBreach {
  type: "net" | "zeta";
  rejectedQuoteTypes: "bid" | "ask";
  cash: number;
  limit: number;
  asset: constants.Asset;
  marketIndex?: MarketIndex;
}

export interface DashboardState {
  getZetaOrders(): any;
  getPosition(
    venue: Venue,
    asset?: constants.Asset,
    index?: MarketIndex
  ): PositionNotificationAgg;

  getTheo(asset: constants.Asset): Theo;

  getRiskStats(venue: Venue): RiskStats | ZetaRiskStats;

  getQuoteBreaches(): QuoteBreach[];
}

export interface ITrader {
  initialize(
    assets: constants.Asset[],
    blockhashFetcher: BlockhashFetcher,
    zetaClient: CrossClient,
    hedgeExchange: ExchangePro
  );
  sendHedgeOrders(orders: HedgeOrder[]): Promise<string[]>;
  sendZetaQuotes(quotes: Quote[]);
  shutdown();
  getHedgeOrders(
    asset: constants.Asset,
    linkOrderIds?: string[]
  ): Promise<Order[]>;
}
