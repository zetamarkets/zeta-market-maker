// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import {
  Wallet,
  Client,
  Exchange,
  utils,
  assets,
  types,
  constants,
} from "@zetamarkets/sdk";
import { Connection, Transaction } from "@solana/web3.js";
import { Config } from "./configuration";
import { State } from "./state";
import { Quote, Theo } from "./types";
import { assetToMarket, initializeClientState, stringifyArr } from "./utils";
import ccxt from "ccxt";
import { convertPriceToOrderPrice } from "./math";
import { convertDecimalToNativeLotSize } from "@zetamarkets/sdk/dist/utils";

export class Maker {
  private config: Config;
  private state: State;
  private zetaClient: Client;
  private markExchange: ccxt.ExchangePro;
  private assets: constants.Asset[];
  private isShuttingDown: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.assets = Array.from(config.assets.keys());
    this.state = new State(config.assets);
    this.markExchange = new ccxt.pro[config.markExchange]();
  }

  async initialize() {
    // Create a solana web3 connection.
    const connection = new Connection(this.config.endpoint, "processed");
    const wallet = new Wallet(this.config.makerWallet);
    const assets = Array.from(this.config.assets.keys());

    const loadExchangeConfig = types.defaultLoadExchangeConfig(
      this.config.network,
      connection,
      utils.defaultCommitment(),
      0,
      true
    );
    await Exchange.load(
      loadExchangeConfig
      // wallet
      // , exchangeCallback
    );

    this.zetaClient = await Client.load(connection, wallet);

    await initializeClientState(this.zetaClient, assets);

    try {
      console.log(`...kicking off periodic fetch monitoring`);
      // periodic refresh of all quotes, to eg. account for missing (filled/cancelled) quotes
      setInterval(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.refreshZetaQuotes(asset);
          })
        );
      }, this.config.requoteIntervalMs);

      console.log(`...kicking off WS monitoring`);
      // monitor maker orderbook for price updates, via WS
      assets.forEach(async (asset) => {
        while (true) await this.monitorMakerOrderbook(asset);
      });

      console.log(`Maker (${this.config.network}) initialized!`);
    } catch (e) {
      console.error(`Script error: ${e}`);
      this.shutdown();
    }
  }

  getTheo(asset: constants.Asset): Theo {
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

  private async monitorMakerOrderbook(asset: constants.Asset) {
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
      this.state.setMarkPriceUpdate(ticker, Date.now());
      const quotes = this.state.calcQuoteRefreshes(asset);
      const theo = this.state.getTheo(asset).theo;
      if (quotes.length > 0) {
        console.log(
          `Refreshing quotes for ${asset} due to price movement: ${theo}: ${stringifyArr(
            quotes
          )}`
        );
        await this.sendZetaQuotes(quotes);
      }
    }
  }

  // recalculate quotes as per currently desired quotes
  private async refreshZetaQuotes(asset: constants.Asset): Promise<void> {
    const subClient = this.zetaClient.subClients.get(asset);
    await subClient.updateState();
    const existingQuotes = this.state.getCurrentQuotes(asset);
    function matches(o: types.Order, q: Quote): boolean {
      return (
        o.marketIndex == q.marketIndex &&
        ((o.side == types.Side.ASK && o.size == q.askSize) ||
          (o.side == types.Side.BID && o.size == q.bidSize))
      );
    }
    const unmatchedOrders = subClient.orders.filter((o) =>
      existingQuotes.every((q) => !matches(o, q))
    );
    const unmatchedQuotes = existingQuotes.filter((q) =>
      subClient.orders.every((o) => !matches(o, q))
    );
    if (unmatchedOrders.length > 0 || unmatchedQuotes.length > 0) {
      const quoteRefreshes = this.state.calcQuoteRefreshes(asset);
      const quotes =
        quoteRefreshes.length > 0 ? quoteRefreshes : existingQuotes;
      console.log(`Refreshing quotes for ${asset} due to unmatched orders & quotes
quotes: ${stringifyArr(quotes)}
unmatched orders: ${stringifyArr(unmatchedOrders)}
unmatched quotes: ${stringifyArr(unmatchedQuotes)}`);
      await this.sendZetaQuotes(quotes);
    } else
      console.log(
        `No quotes (existing ${existingQuotes.length}) to refresh for ${asset}`
      );
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

        if (quote.bidSize != 0)
          ixs.push(
            this.zetaClient.createPlacePerpOrderInstruction(
              quote.asset,
              convertPriceToOrderPrice(quote.bidPrice, true),
              convertDecimalToNativeLotSize(quote.bidSize),
              types.Side.BID
            )
          );

        if (quote.askSize != 0)
          ixs.push(
            this.zetaClient.createPlacePerpOrderInstruction(
              quote.asset,
              convertPriceToOrderPrice(quote.askPrice, false),
              convertDecimalToNativeLotSize(quote.askSize),
              types.Side.ASK
            )
          );

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
          // cancel old quotes in case of an error
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
