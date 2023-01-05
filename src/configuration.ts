import { PublicKey, Keypair } from "@solana/web3.js";
import { utils, network, Network, assets } from "@zetamarkets/sdk";
import { MarketIndex } from "./types";
import ajv from "ajv";

// Before parsing.
export interface ConfigRaw {
  network: string;
  endpoint: string;
  programId: string;
  mmExchange: string;
  positionFetchIntervalMs: number;
  markPriceStaleIntervalMs: number;
  rebalanceIntervalMs: number;
  blockingIntervalMs: number;
  cashDeltaLimit: number;
  assets: Object;
}

export interface SecretsRaw {
  makerWallet: number[];
}

export interface Instrument {
  marketIndex: MarketIndex;
  levels: { priceIncr: number; quoteCashDelta: number }[];
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
  blockingIntervalMs: number;
  cashDeltaLimit: number;
  assets: Map<assets.Asset, AssetParam>;
  // from secrets
  makerWallet: Keypair;
}

export function loadConfig(): Config {
  const config: ConfigRaw = require("../config.json");
  validateSchema(config, require("../config.schema.json"));
  let makerWallet: Keypair = null;
  try {
    makerWallet = Keypair.fromSecretKey(
      Buffer.from(require("../makerWallet.json"))
    );
  } catch (e) {}
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
    blockingIntervalMs: config.blockingIntervalMs,
    cashDeltaLimit: config.cashDeltaLimit,
    assets: assetParams,
    // from secrets
    makerWallet,
  };
  return resConfig;
}

export function validateSchema(config: any, configSchema: any) {
  const ajvInst = new ajv({ strictTuples: false });
  configSchema["$schema"] = undefined;
  const validate = ajvInst.compile(configSchema);
  const valid = validate(config) as boolean;
  if (!valid)
    throw new Error(
      `Failed to validate config due to errors ${JSON.stringify(
        validate.errors
      )}`
    );
}
