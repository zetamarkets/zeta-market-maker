// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import {
  Wallet,
  Client,
  Exchange,
  utils,
  assets,
  programTypes,
  events,
  types,
} from "@zetamarkets/sdk";
import { Connection, Transaction } from "@solana/web3.js";
import { MARKET_INDEXES } from "./constants";
import { Config } from "./configuration";
import { convertPriceToOrderPrice } from "./math";
import { State } from "./state";
import { Quote, Theo } from "./types";
import { assetToMarket, initializeClientState } from "./utils";
import ccxt from "ccxt";

export class Maker {
  private config: Config;
  private state: State;
  private zetaClient: Client;
  private markExchange: ccxt.ExchangePro;
  private assets: assets.Asset[];
  private isShuttingDown: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.assets = Array.from(config.assets.keys());
    this.state = new State(config.assets);
    this.markExchange = new ccxt.pro[config.mmExchange]();
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
      this.shutdown();
    }
  }

  getTheo(asset: assets.Asset): Theo {
    return this.state.getTheo(asset);
  }

  async shutdown() {
    if (!this.isShuttingDown) {
      console.log(`Trader not shutting down already`);
      return;
    }

    this.isShuttingDown = false;
    try {
      let retry = 0;
      while (retry < 10) {
        try {
          await this.zetaClient.cancelAllOrders();
        } catch (e) {
          retry++;
          console.log(`Zeta shutdown error ${e}, retry ${retry}...`);
        }
      }
    } finally {
      this.zetaClient.close();
    }
  }

  private async monitorMMOrderbook(asset: assets.Asset) {
    const market = assetToMarket(asset);
    const orderbook = await this.markExchange.watchOrderBook(market);

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
      if (quotes.length > 0) await this.sendZetaQuotes(quotes);
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
      await this.sendZetaQuotes(replacements);
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

  private async sendZetaQuotes(quotes: Quote[]) {
    await Promise.all(
      quotes.map(async (quote) => {
        let txs = [];
        const ixs = [
          this.zetaClient.createCancelAllMarketOrdersInstruction(
            quote.asset,
            quote.marketIndex
          ),
        ];

        if (quote.bidSize != 0) {
          const price = convertPriceToOrderPrice(quote.bidPrice, true);
          const size = utils.convertDecimalToNativeLotSize(quote.bidSize);
          ixs.push(
            this.zetaClient.createPlaceOrderInstruction(
              quote.asset,
              quote.marketIndex,
              price,
              size,
              types.Side.BID,
              undefined,
              quote.bidClientOrderId
            )
          );
        }

        // add asks quotes
        if (quote.askSize != 0) {
          const price = convertPriceToOrderPrice(quote.askPrice, false);
          const size = utils.convertDecimalToNativeLotSize(quote.askSize);
          ixs.push(
            this.zetaClient.createPlaceOrderInstruction(
              quote.asset,
              quote.marketIndex,
              price,
              size,
              types.Side.ASK,
              undefined,
              quote.askClientOrderId
            )
          );
        }

        const tx = new Transaction().add(...ixs);
        txs.push(tx);

        try {
          // execute first level txs (with cancel)
          await Promise.all(
            txs.map(
              async (tx) =>
                await utils.processTransaction(this.zetaClient.provider, tx)
            )
          );
        } catch (e) {
          // in case of any error - cancel any newly placed orders
          console.log("Failed to send txns, cancelling quotes", e);
          try {
            const cancelTx = new Transaction();
            const marketIndices = quotes.map((x) => x.marketIndex);
            for (var index of marketIndices) {
              cancelTx.add(
                this.zetaClient.createCancelAllMarketOrdersInstruction(
                  quote.asset,
                  index
                )
              );
            }

            await utils.processTransaction(this.zetaClient.provider, cancelTx);
          } catch (e) {
            console.log("Failed to cancel orders", e);
          }
        }
      })
    );
  }
}
