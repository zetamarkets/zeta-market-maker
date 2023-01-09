// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import {
  Wallet,
  Client,
  Exchange,
  utils,
  assets,
  programTypes,
  events,
  Decimal,
} from "@zetamarkets/sdk";
import { Connection } from "@solana/web3.js";
import { Config } from "./configuration";
import { State } from "./state";
import { assetToMarket, initializeClientState } from "./utils";
import ccxt from "ccxt";
import { Quote, Theo } from "./types";
import { Quoter } from "./quoter";
import { MARKET_INDEXES } from "./constants";

export class Maker {
  private config: Config;
  private state: State;
  private quoter: Quoter;
  private zetaClient: Client;
  private mmExchange: ccxt.ExchangePro;
  private assets: assets.Asset[];

  constructor(config: Config) {
    this.config = config;
    this.assets = Array.from(config.assets.keys());
    this.state = new State(config.assets);
    this.mmExchange = new ccxt.pro[config.mmExchange]();
  }

  async initialize() {
    // Create a solana web3 connection.
    const connection = new Connection(this.config.endpoint, "processed");
    const wallet = new Wallet(this.config.makerWallet);
    const assets = Array.from(this.config.assets.keys());

    await Exchange.load(
      assets,
      this.config.programId,
      this.config.network,
      connection,
      utils.defaultCommitment(),
      undefined,
      undefined,
      async (_asset: assets.Asset, eventType: events.EventType, data: any) => {
        if (this.zetaClient) return await this.handleZetaEvent(eventType, data);
      }
    );

    this.zetaClient = await Client.load(
      connection,
      wallet,
      undefined,
      async (_asset: assets.Asset, eventType: events.EventType, data: any) => {
        if (this.zetaClient) return await this.handleZetaEvent(eventType, data);
      }
    );

    await initializeClientState(this.zetaClient, assets);

    this.quoter = new Quoter(this.zetaClient);

    try {
      console.log(`...kicking off WS monitoring`);
      // monitor mm orderbook for price updates, via WS
      assets.forEach(async (asset) => {
        while (true) await this.monitorMMOrderbook(asset);
      });

      console.log(`...kicking off periodic fetch monitoring`);
      // periodic refresh of all quotes, to eg. account for missing (filled) quotes
      setInterval(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.refreshZetaQuotes(asset);
          })
        );
      }, this.config.positionFetchIntervalMs);

      setInterval(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.refreshZetaPositions(asset);
          })
        );
      }, this.config.rebalanceIntervalMs);

      console.log(`Maker (${this.config.network}) initialized!`);
    } catch (e) {
      console.error(`Script error: ${e}`);
      this.quoter.shutdown();
    }
  }

  getTheo(asset: assets.Asset): Theo {
    return this.state.getTheo(asset);
  }

  async shutdown() {
    await this.quoter.shutdown();
  }

  private async monitorMMOrderbook(asset: assets.Asset) {
    const market = assetToMarket(asset);
    const orderbook = await this.mmExchange.watchOrderBook(market);

    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      const ticker = {
        assetName: market,
        asset: asset,
        topLevel: {
          bid: {
            price: orderbook.bids[0][0],
            size: orderbook.bids[0][1],
          },
          ask: {
            price: orderbook.asks[0][0],
            size: orderbook.asks[0][1],
          },
        },
        timestamp: Date.now(),
      };
      const quotes = this.state.setMarkPriceUpdate(ticker, Date.now());
      if (quotes.length > 0) await this.quoter.sendZetaQuotes(quotes);
    }
  }

  // recalculate quotes as per currently set prices
  private async refreshZetaQuotes(asset: assets.Asset): Promise<void> {
    const subClient = this.zetaClient.subClients.get(asset);
    await subClient.updateState();
    const replacements: Quote[] = [];
    const quotes = this.state.getCurrentQuotes(asset) ?? [];
    const liveOrderIds = subClient.orders.map((x) => Number(x.clientOrderId));
    const missing = quotes.filter(
      (x) =>
        !liveOrderIds.includes(Number(x.bidClientOrderId)) ||
        !liveOrderIds.includes(Number(x.askClientOrderId))
    );
    if (missing.length > 0)
      replacements.push(...this.state.calcNewQuotes(asset));

    if (missing.length > 0) {
      console.log(
        `Missing quotes:${JSON.stringify(
          missing
        )} replaced with:${JSON.stringify(replacements)}`
      );
      await this.quoter.sendZetaQuotes(replacements);
    }
  }

  private async handleZetaEvent(eventType: events.EventType, data: any) {
    switch (eventType) {
      case events.EventType.TRADEV2: {
        const event = data as programTypes.TradeEventV2;
        let asset = assets.indexToAsset(event.asset);
        await this.refreshZetaPositions(asset);
        break;
      }
      case events.EventType.USER: {
        await Promise.all(
          this.assets.map(
            async (asset) => await this.refreshZetaPositions(asset)
          )
        );
        break;
      }
    }
  }

  private async refreshZetaPositions(asset: assets.Asset) {
    const subClient = this.zetaClient.subClients.get(asset);
    await subClient.updateState();
    for (var pos of subClient.marginPositions) {
      if (MARKET_INDEXES.includes(pos.marketIndex)) {
        this.state.setPositionUpdate(asset, pos.marketIndex, pos.size);
      }
    }
  }
}
