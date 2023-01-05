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
import { idCreator, initializeClientState, schedule } from "./utils";
import ccxt from "ccxt";
import { assetToMarket, Quote, Theo } from "./types";
import { Trader } from "./trader";
import { MARKET_INDEXES } from "./constants";
import { log } from "./log";
import { Mutex } from "async-mutex";

export class Maker {
  private config: Config;
  private state: State;
  private trader: Trader;
  private zetaClient: Client;
  private mmExchange: ccxt.ExchangePro;
  private assets: assets.Asset[];
  private lock = new Mutex();

  constructor(config: Config) {
    this.config = config;
    this.assets = Array.from(config.assets.keys());
    this.state = new State(config.cashDeltaLimit, config.assets, idCreator());
    this.trader = new Trader();
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
      async (asset: assets.Asset, eventType: events.EventType, data: any) => {
        if (this.zetaClient)
          return await this.handleZetaEvent(asset, eventType, data);
      }
    );

    this.zetaClient = await Client.load(
      connection,
      wallet,
      undefined,
      async (asset: assets.Asset, eventType: events.EventType, data: any) => {
        if (this.zetaClient)
          return await this.handleZetaEvent(asset, eventType, data);
      }
    );

    await initializeClientState(this.zetaClient, assets);

    await this.trader.initialize(assets, this.zetaClient);

    try {
      log.info(`...kicking off WS monitoring`);
      // monitor mm orderbook for price updates, via WS
      assets.forEach(async (asset) => {
        while (true)
          await this.lock.runExclusive(async () => {
            await this.monitorHedgeOrderbook(asset);
          });
      });

      log.info(`...kicking off periodic fetch monitoring`);
      // periodic refresh of all quotes, to eg. account for missing (filled) quotes
      schedule(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.lock.runExclusive(async () => {
              await this.refreshZetaQuotes(asset);
            });
          })
        );
      }, this.config.positionFetchIntervalMs);

      schedule(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.lock.runExclusive(async () => {
              await this.refreshZetaPositions(asset);
            });
          })
        );
      }, this.config.rebalanceIntervalMs);

      log.info(`Maker (${this.config.network}) initialized!`);
    } catch (e) {
      console.error(`Script error: ${e}`);
      this.trader.shutdown();
    }
  }

  getTheo(asset: assets.Asset): Theo {
    return this.state.getTheo(asset);
  }

  async shutdown() {
    await this.trader.shutdown();
  }

  private async monitorHedgeOrderbook(asset: assets.Asset) {
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
      log.debug(
        `Setting ${asset} mark prices: BID ${ticker.topLevel.bid.size} @ ${ticker.topLevel.bid.price}, ASK ${ticker.topLevel.ask.size} @ ${ticker.topLevel.ask.price}`
      );
      const quotes = this.state.setMarkPriceUpdate(ticker, Date.now());
      if (quotes.length > 0) await this.trader.sendZetaQuotes(quotes);
    }
  }

  // recalculate zeta quotes as per currently set prices
  private async refreshZetaQuotes(asset: assets.Asset): Promise<void> {
    const subClient = this.zetaClient.subClients.get(asset);
    await subClient.updateState();
    const toBeRequoted: Quote[] = [];
    const allMissingQuotes: Quote[] = [];
    const quotes = this.state.getCurrentQuotes(asset) ?? [];
    const existingClientOrderIds = subClient.orders.map((x) =>
      Number(x.clientOrderId)
    );
    const missingQuotes = quotes.filter(
      (x) =>
        !existingClientOrderIds.includes(Number(x.bidClientOrderId)) ||
        !existingClientOrderIds.includes(Number(x.askClientOrderId))
    );
    allMissingQuotes.push(...missingQuotes);
    if (missingQuotes.length > 0)
      toBeRequoted.push(...this.state.calcNewQuotes(asset));

    if (allMissingQuotes.length > 0) {
      log.info(
        `Missing quotes:${allMissingQuotes
          .map((x) => `\n- ${JSON.stringify(x)}`)
          .join("")}
replaced with:${toBeRequoted.map((x) => `\n- ${JSON.stringify(x)}`).join("")}`
      );
      if (toBeRequoted.length > 0)
        try {
          await this.trader.sendZetaQuotes(toBeRequoted);
        } catch (e) {
          // swallow error, will be retried
          log.error(
            `Failed to send zeta quotes for ${asset}: ${toBeRequoted
              .map((q) => `\n- ${JSON.stringify(q)}`)
              .join("")}`
          );
        }
    }
  }

  private async handleZetaEvent(
    asset: assets.Asset,
    eventType: events.EventType,
    data: any
  ) {
    switch (eventType) {
      case events.EventType.TRADEV2: {
        const event = data as programTypes.TradeEventV2;
        let asset = assets.indexToAsset(event.asset);
        this.lock.runExclusive(async () => {
          await this.refreshZetaPositions(asset);
        });
        break;
      }
      case events.EventType.USER: {
        // log.info(`Refreshing quotes due to user event`);
        for (var asset of this.assets) {
          this.lock.runExclusive(async () => {
            await this.refreshZetaPositions(asset);
          });
        }
        break;
      }
      case events.EventType.GREEKS: {
        let funding = Decimal.fromAnchorDecimal(
          Exchange.getSubExchange(asset).greeks.perpLatestFundingRate
        );
        let fundingAnnual = funding.toNumber() * 365 * 100;
        // log.info(`Setting new zeta funding rate for ${asset}: ${JSON.stringify(funding)}`);
        this.state.setFunding(asset, fundingAnnual);
        break;
      }
    }
  }

  private async refreshZetaPositions(asset: assets.Asset) {
    const subClient = this.zetaClient.subClients.get(asset);
    await subClient.updateState();
    for (var pos of subClient.marginPositions) {
      if (MARKET_INDEXES.includes(pos.marketIndex)) {
        this.state.setPositionUpdate("zeta", asset, pos.marketIndex, pos.size);
      }
    }
  }
}
