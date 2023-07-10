import {
  assets,
  Exchange,
  constants,
  CrossClient,
  utils,
  instructions,
} from "@zetamarkets/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";

export async function initializeClientState(
  zetaClient: CrossClient,
  usedAssets: constants.Asset[]
) {
  if (zetaClient.accountManager === null) {
    console.log(
      "User has no cross margin account manager. Creating account manager..."
    );
    let tx = new Transaction().add(
      instructions.initializeCrossMarginAccountManagerIx(
        zetaClient.accountManagerAddress,
        zetaClient.publicKey
      )
    );
    await utils.processTransaction(zetaClient.provider, tx);
  }
  if (zetaClient.account === null) {
    console.log("User has no cross margin account. Creating account...");
    let tx = new Transaction().add(
      instructions.initializeCrossMarginAccountIx(
        zetaClient.accountAddress,
        zetaClient.accountManagerAddress,
        zetaClient.publicKey
      )
    );
    await utils.processTransaction(zetaClient.provider, tx);
  }

  for (var a of usedAssets) {
    if (
      zetaClient.openOrdersAccounts[assets.assetToIndex(a)].equals(
        PublicKey.default
      )
    ) {
      console.log(`Creating open orders account for ${assets.assetToName(a)}`);
      await zetaClient.initializeOpenOrdersAccount(a);
    }
  }
}

export function assetToMarket(asset: constants.Asset): string {
  switch (asset) {
    case constants.Asset.BTC:
      return "BTC/USDT:USDT";
    case constants.Asset.ETH:
      return "ETH/USDT:USDT";
    case constants.Asset.SOL:
      return "SOL/USDT:USDT";
  }
}

export function stringifyArr(xs: any[]): string {
  return xs.map((x) => `\n- ${JSON.stringify(x)}`).join("");
}
