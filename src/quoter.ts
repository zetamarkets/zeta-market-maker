import { Transaction } from "@solana/web3.js";
import { Client, types, utils } from "@zetamarkets/sdk";
import { convertPriceToOrderPrice } from "./math";
import { Quote } from "./types";

export class Quoter {
  private zetaClient: Client;
  private isShuttingDown: boolean = false;

  constructor(zetaClient: Client) {
    this.zetaClient = zetaClient;
  }

  async sendZetaQuotes(quotes: Quote[]) {
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
}
