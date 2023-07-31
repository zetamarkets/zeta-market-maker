import { constants } from "@zetamarkets/sdk";
import { MarketIndex, Venue } from "./types";

export interface PositionKey {
  venue?: Venue;
  asset?: constants.Asset;
  marketIndex?: MarketIndex;
}

export function asPositionKey(asStr: string): PositionKey {
  const [venue, asset, marketIndex] = asStr.split("-");
  return {
    venue: venue == "" ? undefined : (venue as Venue),
    asset: asset == "" ? undefined : (asset as constants.Asset),
    marketIndex: +marketIndex,
  };
}

export function asString(asKey: PositionKey): string {
  return `${asKey.venue ?? ""}-${asKey.asset ?? ""}-${asKey.marketIndex ?? ""}`;
}

export class PositionAgg {
  private positions: Map<string, number> = new Map();

  set(key: PositionKey, value: number): boolean {
    if (!key.venue || !key.asset || !key.marketIndex)
      throw new Error(`Need full key for set(): ${JSON.stringify(key)}`);
    const keyStr = `${key.venue}-${key.asset}-${key.marketIndex}`;
    const current = this.positions.get(keyStr);
    const changed = current != value;
    if (changed) this.positions.set(keyStr, value);
    return changed;
  }

  get(key: PositionKey): [PositionKey, number][] {
    return this._getInternal(key).map(([key, value]): [PositionKey, number] => [
      asPositionKey(key),
      value,
    ]);
  }

  getFirst(key: PositionKey): number {
    const positions = this.get(key);
    return positions.length > 0 ? positions[0][1] : undefined;
  }

  sum(key: PositionKey): number {
    const positions = this._getInternal(key);
    return positions.length == 0
      ? undefined
      : positions.reduce((soFar, [_, value]) => value + soFar, 0);
  }

  clone(): PositionAgg {
    const newInstance = new PositionAgg();
    newInstance.positions = new Map(this.positions);
    return newInstance;
  }

  private _getInternal(key: PositionKey): [string, number][] {
    const keyRegexStr =
      (key.venue ?? "[A-Za-z]+") +
      "-" +
      (key.asset ?? "[A-Za-z]+") +
      "-" +
      (key.marketIndex ?? "[0-9]+");
    const keyRegex = new RegExp(keyRegexStr);
    return Array.from(this.positions.entries()).filter(([key, _]) =>
      keyRegex.test(key)
    );
  }
}
