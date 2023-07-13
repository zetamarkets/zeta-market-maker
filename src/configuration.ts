import { PublicKey, Keypair } from "@solana/web3.js";
import { utils, network, Network, assets, constants } from "@zetamarkets/sdk";

export interface ConfigRaw {
  network: string;
  endpoint: string;
  programId: string;
  markExchange: string;
  requoteIntervalMs: number;
  markPriceStaleIntervalMs: number;
  assets: Object;
}

export interface AssetParam {
  quoteLotSize: number;
  widthBps: number;
  requoteBps: number;
  quoteCashDelta: number;
}

export interface Config {
  network: Network;
  endpoint: string;
  programId: PublicKey;
  markExchange: string;
  requoteIntervalMs: number;
  markPriceStaleIntervalMs: number;
  assets: Map<constants.Asset, AssetParam>;
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
  const paramAssets: constants.Asset[] = utils.toAssets(
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
    markExchange: config.markExchange,
    requoteIntervalMs: config.requoteIntervalMs,
    markPriceStaleIntervalMs: config.markPriceStaleIntervalMs,
    assets: assetParams,
    // from secrets
    makerWallet,
  };
  return resConfig;
}
