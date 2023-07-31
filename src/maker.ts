// Orchestrates initialization (with fallback), listening to all the feeds, and processing of effects

import {
  Wallet,
  CrossClient,
  Exchange,
  utils,
  assets,
  programTypes,
  events,
  Decimal,
  types,
  constants,
} from "@zetamarkets/sdk";

import { Connection } from "@solana/web3.js";
import { Config } from "./configuration";
import { Effects, QuotingEffects, State } from "./state";
import {
  appendToCSV,
  idCreator,
  initializeClientState,
  instrumentDescription,
  marketIndexToName,
  schedule,
  convertToReadableOrders,
} from "./utils";
import { BlockhashFetcher } from "./blockhash";
import { Exchange as ExchangePro, OrderBook, binanceusdm, pro } from "ccxt";
import {
  assetToMarket,
  assetToBinanceMarket,
  ITrader,
  MarketIndex,
  PositionNotificationAgg,
  QuoteBreach,
  RiskStats,
  Theo,
  Venue,
  ZetaRiskStats,
} from "./types";
import { PermissionedTrader } from "./trader";
import { log } from "./log";
import { LockedRunner } from "./lock";

export class Maker {
  private config: Config;
  private blockhashFetcher: BlockhashFetcher;
  private state: State;
  private trader: ITrader;
  private zetaClient: CrossClient;
  private hedgeExchange: ExchangePro;
  private zetaRiskStats: ZetaRiskStats; // Q: should be part of state.rs?
  private hedgeRiskStats: RiskStats; // not assigned to an asset. Q: should be part of state.rs?
  private assets: constants.Asset[];
  private lockedRunner: LockedRunner;
  private quotingBreaches: Map<constants.Asset, QuoteBreach[]> = new Map();
  private binanceExchange: binanceusdm;

  constructor(config: Config) {
    this.config = config;
    this.blockhashFetcher = new BlockhashFetcher(config.endpoint);
    this.blockhashFetcher.subscribe();
    this.assets = Array.from(config.assets.keys());
    this.lockedRunner = new LockedRunner(config.lockingIntervalMs, [
      ...this.assets.flatMap((asset) => [
        `zeta-quotes-${asset}`,
        `hedge-orders-${asset}`,
      ]),
    ]);
    this.state = new State(
      config.cashDeltaHedgeThreshold,
      config.assets,
      instrumentDescription,
      idCreator()
    );

    this.trader = new PermissionedTrader(config.tifExpiryOffsetMs / 1000);

    this.hedgeExchange = new pro[config.hedgeExchange](
      config.credentials[config.hedgeExchange]
    );
    if (config.useHedgeTestnet)
      this.hedgeExchange.urls["api"] = this.hedgeExchange.urls["test"];

    this.binanceExchange = new binanceusdm();
  }

  async initialize() {
    // Create a solana web3 connection.
    const connection = new Connection(this.config.endpoint, "processed");
    const wallet = new Wallet(this.config.makerWallet);
    const assets = Array.from(this.config.assets.keys());

    await Exchange.load(
      {
        network: this.config.network,
        connection,
        opts: utils.defaultCommitment(),
        throttleMs: 0,
        loadFromStore: true,
      },
      undefined,
      async (
        asset: constants.Asset,
        eventType: events.EventType,
        data: any
      ) => {
        if (this.zetaClient)
          return await this.handleZetaEvent(asset, eventType, data);
      }
    );

    Exchange.toggleAutoPriorityFee();

    this.zetaClient = await CrossClient.load(
      connection,
      wallet,
      undefined,
      async (
        asset: constants.Asset,
        eventType: events.EventType,
        data: any
      ) => {
        if (this.zetaClient)
          return await this.handleZetaEvent(asset, eventType, data);
      }
    );

    await initializeClientState(this.zetaClient);

    await this.trader.initialize(
      assets,
      this.blockhashFetcher,
      this.zetaClient,
      this.hedgeExchange
    );

    try {
      // monitor hedge orderbook for price updates, via WS
      assets.forEach(async (asset) => {
        while (true) {
          const market = assetToMarket(asset);

          let orderbook: OrderBook;
          try {
            const market = assetToBinanceMarket(asset);
            orderbook = await this.binanceExchange.fetchOrderBook(market);
          } catch (e) {
            log.warn(
              `Fetching binance exchange failed, using bybit orderbook instead: ${e}`
            );
            const market = assetToMarket(asset);
            orderbook = await this.hedgeExchange.watchOrderBook(market);
          }

          if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
            const nowTs = Date.now();
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
              timestamp: nowTs,
            };
            log.debug(
              `Setting ${asset} mark prices: BID ${ticker.topLevel.bid.size} @ ${ticker.topLevel.bid.price}, ASK ${ticker.topLevel.ask.size} @ ${ticker.topLevel.ask.price}`
            );
            this.state.setMarkPriceUpdate(ticker, nowTs);

            // Note: not awaiting the following as that impacts the price setting cycle, causing stale prices
            this.lockedRunner.runExclusive(
              `zeta-quotes-${asset}`,
              `reject`, // won't re-quote if did so recently
              async () => {
                const effects = this.state.calcQuoting(asset);
                await this.handleQuotingEffects(effects, asset);
                log.debug(`Finished mark price update for ${asset}`);
              }
            );
          } else
            log.debug(
              `Received empty ${asset} orderbook, skipping mark price update`
            );
        }
      });

      // monitor hedge trades, via WS
      // follow up with position re-fetch
      assets.forEach(async (asset) => {
        while (true) {
          const market = assetToMarket(asset);
          const myTrades = await this.hedgeExchange.watchMyTrades(market);
          await Promise.all(
            myTrades.map(async (trade) =>
              console.log("Hedge exchange trade:", trade)
            )
          );
          if (myTrades.length > 0)
            await this.lockedRunner.runExclusive(
              `hedge-orders-${asset}`,
              `reject`, // won't publish hedge orders if done so recently
              async () => await this.refreshHedgePositions(asset)
            );
          else
            log.debug(
              `Received no hedge trades for ${asset}, skipping position update`
            );
        }
      });

      await this.fetchZetaRiskStats();
      await this.fetchHedgeRiskStats();
      let totalBalance = 0;

      totalBalance += this.zetaRiskStats.balance + this.zetaRiskStats.pnlTotal;

      appendToCSV("balances/zeta-balance.csv", totalBalance.toFixed(2));
      appendToCSV(
        "balances/hedge-balance.csv",
        (this.hedgeRiskStats.balance + this.hedgeRiskStats.pnl).toFixed(2)
      );
      totalBalance += this.hedgeRiskStats.balance + this.hedgeRiskStats.pnl;
      appendToCSV("balances/total-balance.csv", totalBalance.toFixed(2));

      setInterval(() => {
        let totalBalance = 0;

        totalBalance +=
          this.zetaRiskStats.balance + this.zetaRiskStats.pnlTotal;
        appendToCSV("balances/zeta-balance.csv", totalBalance.toFixed(2));
        appendToCSV(
          "balances/hedge-balance.csv",
          (this.hedgeRiskStats.balance + this.hedgeRiskStats.pnl).toFixed(2)
        );
        totalBalance += this.hedgeRiskStats.balance + this.hedgeRiskStats.pnl;
        appendToCSV("balances/total-balance.csv", totalBalance.toFixed(2));
      }, 10_800_000);

      // periodic refresh of all quotes, to eg. account for missing (filled) quotes
      schedule(async () => {
        await Promise.all(
          this.assets.map(
            async (asset) =>
              await this.lockedRunner.runExclusive(
                `zeta-quotes-${asset}`,
                `wait`, // ensures snapshot update always happens
                async () => await this.refreshZetaQuotes(asset)
              )
          )
        );
      }, this.config.quoteIntervalMs);

      schedule(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.lockedRunner.runExclusive(
              `hedge-orders-${asset}`,
              `wait`, // ensure snapshot update always happens
              async () => await this.refreshZetaPositions(asset)
            );
          })
        );
      }, this.config.positionRefreshIntervalMs);

      schedule(async () => {
        await Promise.all(
          this.assets.map(async (asset) => {
            await this.lockedRunner.runExclusive(
              `hedge-orders-${asset}`,
              `wait`, // ensure snapshot update always happens
              async () => await this.refreshHedgePositions(asset)
            );
          })
        );
      }, this.config.positionRefreshIntervalMs);

      // periodic fetch of risk stats
      schedule(
        this.fetchZetaRiskStats.bind(this),
        this.config.riskStatsFetchIntervalMs
      );
      schedule(
        this.fetchHedgeRiskStats.bind(this),
        this.config.riskStatsFetchIntervalMs
      );

      log.info(`Maker (${this.config.network}) initialized!`);
    } catch (e) {
      console.error(`Script error: ${e}`);
      this.trader.shutdown();
    }
  }

  getZetaOrders(): any {
    return [convertToReadableOrders(this.zetaClient.orders)];
  }

  getPosition(
    venue: Venue,
    asset: constants.Asset,
    index?: number
  ): PositionNotificationAgg {
    return this.state.getPosition(venue, asset, index);
  }

  getTheo(asset: constants.Asset): Theo {
    return this.state.getTheo(asset);
  }

  getRiskStats(venue: Venue): RiskStats | ZetaRiskStats {
    if (venue == "zeta") return this.zetaRiskStats;
    else return this.hedgeRiskStats;
  }

  getQuoteBreaches(): QuoteBreach[] {
    return Array.from(this.quotingBreaches.values()).flatMap((x) => x);
  }

  async shutdown() {
    await this.trader.shutdown();
  }

  // recalculate zeta quotes as per currently set prices
  private async refreshZetaQuotes(asset: constants.Asset): Promise<void> {
    await this.zetaClient.updateOrders();
    const quotes = this.state.getCurrentQuotes(asset)?.quotes ?? [];

    let orders = this.zetaClient.getOrders(asset);
    const existingClientOrderIds = orders.map((x) => Number(x.clientOrderId));
    const missingQuotes = quotes.filter(
      (x) => !existingClientOrderIds.includes(Number(x.clientOrderId))
    );
    if (missingQuotes.length > 0) {
      const effects = this.state.calcNewQuotes(asset);
      log.info(
        `Generating new quotes due to missing clientOrderIds ${missingQuotes
          .map((x) => `${x.clientOrderId}`)
          .join(", ")}:${effects.quotes
          .map((x) => `\n- ${JSON.stringify(x)}`)
          .join("")}`
      );
      await this.handleQuotingEffects(effects, asset);
    } else
      log.debug(
        `Desired zeta quotes matching existing orders, no need to re-quote`
      );
  }

  private async handleZetaEvent(
    _asset: constants.Asset,
    eventType: events.EventType,
    data: any
  ) {
    switch (eventType) {
      case events.EventType.TRADEV3: {
        const event = data as programTypes.TradeEventV3;
        let price = utils.getTradeEventPrice(event);
        let size = utils.convertNativeLotSizeToDecimal(event.size.toNumber());
        let asset = assets.fromProgramAsset(event.asset);
        let side = event.isBid ? "[BID]" : "[ASK]";
        let makerOrTaker = event.isTaker ? "[TAKER]" : "[MAKER]";
        let name = marketIndexToName(asset, event.index);
        log.info(
          `[TRADE] [${asset}-${name}] ${side} ${makerOrTaker} [PRICE] ${price} [SIZE] ${size}`
        );
        await this.lockedRunner.runExclusive(
          `hedge-orders-${asset}`,
          `reject`,
          async () => await this.refreshZetaPositions(asset)
        );
        break;
      }
      case events.EventType.ORDERCOMPLETE: {
        const asset = Object.keys(
          data.asset
        )[0].toUpperCase() as constants.Asset;
        const orderCompleteType = Object.keys(data.orderCompleteType)[0];
        const knownClientOrderIds =
          this.state
            .getCurrentQuotes(asset)
            ?.quotes.map((x) => x.clientOrderId) ?? [];
        const cancelledKnownQuote = knownClientOrderIds.includes(
          data.clientOrderId.toNumber()
        );
        if (cancelledKnownQuote) {
          log.info(
            `Received ORDERCOMPLETE ${orderCompleteType} event on ${asset}-${
              data.marketIndex
            }, known clientOrderId ${data.clientOrderId.toNumber()}, refreshing Zeta quotes`
          );
          await this.lockedRunner.runExclusive(
            `zeta-quotes-${asset}`,
            `reject`, // won't re-quote if did so recently
            async () => await this.refreshZetaQuotes(asset)
          );
        } else {
          // noop, presume it's been dealt with
          log.debug(
            `Received ORDERCOMPLETE ${orderCompleteType} event on ${asset}-${
              data.marketIndex
            }, unknown clientOrderId ${data.clientOrderId.toNumber()}, skipping`
          );
        }
        break;
      }
      case events.EventType.USER: {
        await Promise.all(
          this.assets.map(async (asset) =>
            this.lockedRunner.runExclusive(
              `hedge-orders-${asset}`,
              `reject`,
              async () => await this.refreshZetaPositions(asset)
            )
          )
        );
        break;
      }
      case events.EventType.PRICING: {
        Exchange.assets.map((a) => {
          let funding = Decimal.fromAnchorDecimal(
            Exchange.pricing.latestFundingRates[assets.assetToIndex(a)]
          );
          let fundingAnnual = funding.toNumber() * 365 * 100;
          this.state.setFunding(a, fundingAnnual);
        });
        break;
      }
    }
  }

  private async refreshHedgePositions(asset: constants.Asset) {
    // first sync up hedge exchange positions. Note: not handling effects yet
    try {
      const market = assetToMarket(asset);
      const res = await this.hedgeExchange.fetchPosition(market);
      const size = (res?.side == "long" ? 1 : -1) * (res?.contracts ?? 0);
      const effects = this.state.setPositionUpdate(
        "hedge",
        asset,
        MarketIndex.PERP,
        size,
        true
      );

      await this.handleEffects(effects);
    } catch (e) {
      log.error(
        `Failed to refresh hedge positions for ${asset}, continuing...`,
        e
      );
    }
  }

  private async refreshZetaPositions(asset: constants.Asset) {
    await Promise.all([this.zetaClient.updateState()]);

    let zetaMarginPositions = this.zetaClient.getPositions(asset);

    let totalPositions: Map<number, types.Position> = new Map();

    for (var pos of zetaMarginPositions) {
      if (totalPositions.has(pos.marketIndex)) {
        let oldPosition = totalPositions.get(pos.marketIndex);
        oldPosition.costOfTrades += pos.costOfTrades;
        oldPosition.size += pos.size;
        totalPositions.set(pos.marketIndex, oldPosition);
      } else {
        totalPositions.set(pos.marketIndex, pos);
      }
    }

    totalPositions.forEach(async (v, k) => {
      try {
        const effects = this.state.setPositionUpdate(
          "zeta",
          asset,
          v.marketIndex,
          v.size
        );
        await this.handleEffects(effects);
      } catch (e) {
        log.error(
          `Failed to refresh zeta positions for ${asset}-${pos.marketIndex} due to ${e}`
        );
      }
    });
  }

  private async fetchZetaRiskStats() {
    await Promise.all([this.zetaClient.updateState()]);
    log.debug(`Fetching zeta risk stats`);

    let marginState = this.zetaClient.getAccountState();

    let perAssetMap = new Map();
    for (let a of this.assets) {
      let ms = marginState.assetState.get(a);

      perAssetMap.set(a, {
        margin: ms.maintenanceMargin,
        pnl: ms.unrealizedPnl,
      });
    }

    this.zetaRiskStats = {
      balance: marginState.balance,
      marginTotal: marginState.maintenanceMarginTotal,
      availableBalanceTotal: marginState.availableBalanceWithdrawable,
      pnlTotal: marginState.unrealizedPnlTotal,
      perAsset: perAssetMap,
    };
  }

  private async fetchHedgeRiskStats(): Promise<void> {
    try {
      log.debug(`Fetching hedge risk stats`);
      const balance = await this.hedgeExchange.fetchBalance({
        coin: "USDT",
      });

      const balanceRawInfo = balance.info.result.list.find(
        (x) => x.coin == "USDT"
      );

      this.hedgeRiskStats = {
        balance: balance.USDT.total as number, // or balanceRawInfo.walletBalance
        margin: balance.USDT.used as number, // or balanceRawInfo.positionMargin
        availableBalance: balance.USDT.free as number, // or balanceRawInfo.availableBalance
        pnl: +balanceRawInfo.unrealisedPnl,
      };
    } catch (e) {
      log.error(
        `Failed to update Hedge (${this.config.hedgeExchange}) risk stats, continuing...`
      );
    }
  }

  private async handleEffects(effects: Effects) {
    const allPromises: Promise<any>[] = [];
    if (effects.hedgeOrders.length > 0) {
      allPromises.push(this.trader.sendHedgeOrders(effects.hedgeOrders));
    }
    await Promise.all(allPromises.map(async (p) => await p));
  }

  private async handleQuotingEffects(
    effects: QuotingEffects,
    asset: constants.Asset
  ) {
    try {
      this.quotingBreaches.set(asset, effects.breaches);

      if (effects.quotes.length > 0)
        await this.trader.sendZetaQuotes(effects.quotes);
    } catch (e) {
      // swallow error, will be retried
      log.error(
        `Failed to send ${
          effects.quotes.length
        } zeta quotes for ${asset}: ${effects.quotes
          .map((q) => `\n- ${JSON.stringify(q)}`)
          .join("")}
due to ${e}`
      );
    }
  }
}
