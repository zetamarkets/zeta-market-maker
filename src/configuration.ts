import { PublicKey, Keypair } from "@solana/web3.js";
import { utils, network, Network, assets, constants } from "@zetamarkets/sdk";
import { MarketIndex } from "./types";
import ajv from "ajv";

// Before parsing.
export interface ConfigRaw {
  network: string;
  endpoint: string;
  programId: string;
  mintAuthority: number[];
  webServerPort: number;
  hedgeExchange: string;
  quoteIntervalMs: number;
  tifExpiryOffsetMs: number;
  markPriceStaleIntervalMs: number;
  positionRefreshIntervalMs: number;
  riskStatsFetchIntervalMs;
  lockingIntervalMs: number;
  cashDeltaHedgeThreshold: number;
  useHedgeTestnet: boolean;
  assets: Object;
}

export interface SecretsRaw {
  makerWallet: number[];
  credentials: Object;
}

export interface Instrument {
  marketIndex: MarketIndex;
  levels: { priceIncr: number; quoteCashDelta: number }[];
}

export interface AssetParam {
  maxZetaCashExposure: number;
  maxNetCashDelta: number;
  quoteLotSize: number;
  widthBps: number;
  requoteBps: number;
  instruments: Instrument[];
  leanBps: number;
}

export interface Config {
  network: Network;
  endpoint: string;
  programId: PublicKey;
  mintAuthority: Keypair | null; // Not required for mainnet
  webServerPort: number;
  hedgeExchange: string;
  quoteIntervalMs: number;
  tifExpiryOffsetMs: number;
  markPriceStaleIntervalMs: number;
  positionRefreshIntervalMs: number;
  riskStatsFetchIntervalMs: number;
  lockingIntervalMs: number;
  cashDeltaHedgeThreshold: number;
  useHedgeTestnet: boolean;
  assets: Map<constants.Asset, AssetParam>;
  // from secrets
  makerWallet: Keypair;
  credentials: Object;
}

export function loadConfig(): Config {
  const config: ConfigRaw = require("../config.json");
  const secrets: SecretsRaw = require("../secrets.json");
  validateSchema(config, require("../config.schema.json"));
  validateSchema(secrets, require("../secrets.schema.json"));
  const net: Network = network.toNetwork(config.network);
  const paramAssets: constants.Asset[] = utils.toAssets(
    Object.keys(config.assets)
  );
  const programId: PublicKey = new PublicKey(config.programId);
  let makerWallet: Keypair = null;
  let mintAuthority: Keypair = null;
  let assetParams = new Map();
  for (var a of paramAssets) {
    assetParams.set(a, config.assets[assets.assetToName(a)]);
  }

  try {
    makerWallet = Keypair.fromSecretKey(Buffer.from(secrets.makerWallet));
  } catch (e) {}

  try {
    mintAuthority = Keypair.fromSecretKey(Buffer.from(config.mintAuthority));
  } catch (e) {}

  const resConfig = {
    network: net,
    endpoint: config.endpoint,
    programId,
    mintAuthority,
    webServerPort: config.webServerPort,
    hedgeExchange: config.hedgeExchange,
    quoteIntervalMs: config.quoteIntervalMs,
    tifExpiryOffsetMs: config.tifExpiryOffsetMs,
    markPriceStaleIntervalMs: config.markPriceStaleIntervalMs,
    positionRefreshIntervalMs: config.positionRefreshIntervalMs,
    riskStatsFetchIntervalMs: config.riskStatsFetchIntervalMs,
    lockingIntervalMs: config.lockingIntervalMs,
    cashDeltaHedgeThreshold: config.cashDeltaHedgeThreshold,
    useHedgeTestnet: config.useHedgeTestnet,
    assets: assetParams,
    // from secrets
    makerWallet,
    credentials: secrets.credentials,
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
