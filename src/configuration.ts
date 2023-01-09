import { PublicKey, Keypair } from "@solana/web3.js";
import { utils, network, Network, assets } from "@zetamarkets/sdk";
import { MarketIndex } from "./types";

// Before parsing.
export interface ConfigRaw {
  network: string;
  endpoint: string;
  programId: string;
  mmExchange: string;
  positionFetchIntervalMs: number;
  markPriceStaleIntervalMs: number;
  rebalanceIntervalMs: number;
  assets: Object;
}

export interface Instrument {
  marketIndex: MarketIndex;
  quoteCashDelta: number;
}

export interface AssetParam {
  maxCashDelta: number;
  quoteLotSize: number;
  widthBps: number;
  requoteBps: number;
  instruments: Instrument[];
}

export interface Config {
  network: Network;
  endpoint: string;
  programId: PublicKey;
  mmExchange: string;
  positionFetchIntervalMs: number;
  markPriceStaleIntervalMs: number;
  rebalanceIntervalMs: number;
  assets: Map<assets.Asset, AssetParam>;
  // from secrets file
  makerWallet: Keypair;
}

export function loadConfig(): Config {
  const config: ConfigRaw = require("../config.json");
  let makerWallet: Keypair = null;
  makerWallet = Keypair.fromSecretKey(
    Buffer.from(require("../makerWallet.json"))
  );
  const net: Network = network.toNetwork(config.network);
  const paramAssets: assets.Asset[] = utils.toAssets(
    Object.keys(config.assets)
  );
  const programId: PublicKey = new PublicKey(config.programId);
  let assetParams = new Map();
  for (var a of paramAssets) {
    assetParams.set(a, config.assets[assets.assetToName(a)]);
  }

  const resConfig = {
    network: net,
    endpoint: config.endpoint,
    programId,
    mmExchange: config.mmExchange,
    positionFetchIntervalMs: config.positionFetchIntervalMs,
    markPriceStaleIntervalMs: config.markPriceStaleIntervalMs,
    rebalanceIntervalMs: config.rebalanceIntervalMs,
    assets: assetParams,
    // from secrets
    makerWallet,
  };
  return resConfig;
}
