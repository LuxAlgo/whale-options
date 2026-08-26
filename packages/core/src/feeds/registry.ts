/*
  Feed registry — adapters self-describe and the CLI/MCP resolve them by id.
  Real vendor adapters (thetadata/massive/alpaca/tradier) register here as
  they land; synthetic and replay are always available because they are the
  demo and the test substrate.
*/
import type { WhaleConfig } from "../config.js";
import type { FeedId } from "../types.js";
import type { FeedAdapter } from "./types.js";

export type FeedFactory = (config: WhaleConfig) => FeedAdapter;

const factories = new Map<FeedId, FeedFactory>();

export function registerFeed(id: FeedId, factory: FeedFactory): void {
  factories.set(id, factory);
}

export function createFeed(id: FeedId, config: WhaleConfig): FeedAdapter {
  const factory = factories.get(id);
  if (!factory) {
    const known = [...factories.keys()].join(", ");
    throw new Error(`unknown feed "${id}" — registered feeds: ${known}`);
  }
  return factory(config);
}

export function registeredFeeds(): FeedId[] {
  return [...factories.keys()];
}
