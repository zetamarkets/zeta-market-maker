import {
  Connection,
  Commitment,
  RpcResponseAndContext,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

export class BlockhashFetcher {
  private connection: Connection;
  private commitment: Commitment;
  private intervalMs: number;
  private refreshIntervalId: NodeJS.Timer;
  private blockhashAndContext: RpcResponseAndContext<BlockhashWithExpiryBlockHeight>;

  constructor(
    url: string,
    commitment: Commitment = `finalized`,
    intervalMs: number = 200
  ) {
    this.connection = new Connection(url, commitment);
    this.commitment = commitment;
    this.intervalMs = intervalMs;
  }

  public get blockhash() {
    return this.blockhashAndContext?.value;
  }

  subscribe() {
    this.refreshIntervalId = setInterval(
      async () =>
        (this.blockhashAndContext =
          await this.connection.getLatestBlockhashAndContext(this.commitment)),
      this.intervalMs
    );
  }

  shutdown() {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId);
  }
}
