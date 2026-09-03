/*
  Engine configuration — zod-validated, fully defaulted. Every threshold the
  classifier and scorer use lives here, on purpose: the incumbents sell these
  numbers as proprietary detection; here they are config with documented
  defaults. `whale.config.ts` exports the result of defineConfig(...); env
  vars carry secrets (feed keys, sink tokens) and never live in the file.
*/
import { z } from "zod";

export const feedIdSchema = z.enum([
  "thetadata",
  "massive",
  "alpaca",
  "tradier",
  "replay",
  "synthetic",
]);

export const alertRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  match: z
    .object({
      minScore: z.number().min(0).max(100).optional(),
      minPremium: z.number().min(0).optional(),
      tickers: z.array(z.string().min(1)).optional(),
      side: z.array(z.enum(["buy", "sell", "mid", "unknown"])).optional(),
      kind: z.array(z.enum(["sweep", "block", "split", "print"])).optional(),
      maxDte: z.number().min(0).optional(),
      minVolOi: z.number().min(0).optional(),
      excludeColdStart: z.boolean().default(true),
    })
    .default({}),
  sink: z.discriminatedUnion("type", [
    z.object({ type: z.literal("stdout") }),
    z.object({
      type: z.literal("webhook"),
      url: z.string().url(),
      /** Name of the env var holding an optional HMAC-SHA256 signing secret. */
      secretEnv: z.string().optional(),
      /** "flow-event" posts the full event; "order-signal" posts a compact
       *  {ticker, action, ...} body that webhook-driven executors accept. */
      template: z.enum(["flow-event", "order-signal"]).default("flow-event"),
    }),
    z.object({
      type: z.literal("discord"),
      /** Name of the env var holding the Discord webhook URL. */
      webhookUrlEnv: z.string().default("WHALE_DISCORD_WEBHOOK_URL"),
    }),
    z.object({
      type: z.literal("telegram"),
      botTokenEnv: z.string().default("WHALE_TELEGRAM_BOT_TOKEN"),
      chatIdEnv: z.string().default("WHALE_TELEGRAM_CHAT_ID"),
    }),
    z.object({ type: z.literal("desktop") }),
  ]),
  /** Minimum seconds between fires of this rule for the same contract. */
  cooldownSec: z.number().min(0).default(60),
});

export type AlertRule = z.infer<typeof alertRuleSchema>;

export const configSchema = z.object({
  feed: z
    .object({
      id: feedIdSchema.default("synthetic"),
      /** Replay feed: path to an NDJSON tape file. */
      tapePath: z.string().optional(),
      /** Synthetic feed knobs (all optional; see feeds/synthetic). */
      synthetic: z
        .object({
          seed: z.number().int().default(42),
          regime: z.enum(["mixed", "quiet", "sweep-clusters", "earnings-ramp"]).default("mixed"),
          eventsPerMinute: z.number().positive().default(120),
        })
        .default({}),
      /** ThetaData: local Theta Terminal v3 endpoints. Env overrides:
       *  THETADATA_BASE_URL / THETADATA_WS_URL. */
      thetadata: z
        .object({
          baseUrl: z.string().default("http://127.0.0.1:25503"),
          wsUrl: z.string().default("ws://127.0.0.1:25520/v1/events"),
        })
        .default({}),
      /** Massive (formerly Polygon.io). Key env: MASSIVE_API_KEY (or
       *  POLYGON_API_KEY). "delayed" selects the 15-minute-delayed WS host. */
      massive: z
        .object({
          stream: z.enum(["realtime", "delayed"]).default("realtime"),
          restBase: z.string().default("https://api.massive.com"),
        })
        .default({}),
      /** Alpaca. Key envs: ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY.
       *  "indicative" is the free options feed; "opra" needs a subscription. */
      alpaca: z
        .object({
          stream: z.enum(["indicative", "opra"]).default("indicative"),
        })
        .default({}),
      /** Tradier. Key env: TRADIER_ACCESS_TOKEN. Point apiBase at
       *  https://sandbox.tradier.com/v1 for sandbox REST (no streaming there). */
      tradier: z
        .object({
          apiBase: z.string().default("https://api.tradier.com/v1"),
        })
        .default({}),
    })
    .default({}),
  universe: z
    .object({
      /** Underlyings to subscribe to. Empty = whatever the feed defaults to.
       *  The engine never assumes it sees the whole market. */
      underlyings: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  engine: z
    .object({
      /** Rolling multi-exchange sweep window (per contract+side). */
      sweepWindowMs: z.number().min(100).max(2000).default(500),
      ladder: z
        .object({
          /** Same-contract same-side clips inside windowMs ⇒ split/ladder. */
          minClips: z.number().int().min(2).default(4),
          windowMs: z.number().positive().default(600_000),
          minClipSize: z.number().int().min(1).default(5),
        })
        .default({}),
      block: z
        .object({
          /** Percentile of the liquidity bucket's trade-size distribution. */
          quantile: z.number().min(0.5).max(1).default(0.995),
          /** Floors per liquidity bucket — dynamic thresholds never go below. */
          minSize: z
            .object({
              illiquid: z.number().int().default(50),
              low: z.number().int().default(100),
              mid: z.number().int().default(250),
              high: z.number().int().default(500),
            })
            .default({}),
          /** 20d-avg daily contract volume bounds separating the buckets. */
          bucketBounds: z.tuple([z.number(), z.number(), z.number()]).default([200, 2000, 20000]),
        })
        .default({}),
      /** NBBO older than this vs the print ⇒ aggressor side is "unknown". */
      nbboStaleMs: z.number().positive().default(5000),
      emit: z
        .object({
          /** Events below this premium are classified but not emitted. */
          minPremium: z.number().min(0).default(10_000),
          /** Emit spread legs as (unscored) events. Off by default. */
          spreadLegs: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  score: z
    .object({
      weights: z
        .object({
          volumeVsBaseline: z.number().min(0).default(0.2),
          premiumVsBaseline: z.number().min(0).default(0.2),
          volOi: z.number().min(0).default(0.15),
          aggression: z.number().min(0).default(0.2),
          urgency: z.number().min(0).default(0.1),
          repetition: z.number().min(0).default(0.15),
        })
        .default({}),
      caps: z
        .object({
          /** Day-volume multiple of 20d average that maps to 1.0. */
          volumeMult: z.number().positive().default(20),
          /** Volume/OI ratio that maps to 1.0 (log-scaled). */
          volOi: z.number().positive().default(4),
          /** Same-session repeat count that maps to 1.0 (log-scaled). */
          repetition: z.number().positive().default(8),
        })
        .default({}),
      urgency: z
        .object({
          /** e-folding of the DTE factor, in days. */
          dteTauDays: z.number().positive().default(10),
          /** OTM distance (as fraction of spot) that maps to 1.0. */
          otmScale: z.number().positive().default(0.15),
        })
        .default({}),
      aggression: z
        .object({
          atQuote: z.number().min(0).max(1).default(0.7),
          throughQuote: z.number().min(0).max(1).default(1.0),
          mid: z.number().min(0).max(1).default(0.2),
          unknown: z.number().min(0).max(1).default(0),
          sweepBonus: z.number().min(0).max(1).default(0.2),
          isoBonus: z.number().min(0).max(1).default(0.1),
        })
        .default({}),
      /** Fewer baseline days than this ⇒ event flagged coldStart. */
      minBaselineDays: z.number().int().min(0).default(5),
      /** Premium-percentile component needs at least this many samples. */
      minPremiumSamples: z.number().int().min(1).default(50),
      /** Rolling baseline lookback, in sessions. */
      lookbackDays: z.number().int().min(1).default(20),
    })
    .default({}),
  greeks: z
    .object({
      /** Risk-free rate used when the feed provides no greeks (documented default). */
      r: z.number().default(0.05),
      /** Dividend yield; per-underlying overrides win. */
      q: z.number().default(0),
      qByUnderlying: z.record(z.string(), z.number()).default({}),
      gexConvention: z
        .enum(["dealer-long-calls-short-puts", "dealer-short-calls-long-puts"])
        .default("dealer-long-calls-short-puts"),
    })
    .default({}),
  alerts: z
    .object({
      rules: z.array(alertRuleSchema).default([]),
    })
    .default({}),
  /** Per-print flow series (flow/series.ts): bucket width for the intraday
   *  net-premium / directional-delta / net-volume / spot-tape series. */
  flowSeries: z
    .object({
      bucketMs: z.number().int().min(1_000).default(60_000),
    })
    .default({}),
  store: z
    .object({
      driver: z.enum(["sqlite", "memory"]).default("sqlite"),
      path: z.string().default(".whale/whale.db"),
      ticksRetentionDays: z.number().int().min(1).default(7),
      eventsRetentionDays: z.number().int().min(1).default(90),
    })
    .default({}),
  server: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8787),
    })
    .default({}),
});

export type WhaleConfigInput = z.input<typeof configSchema>;
export type WhaleConfig = z.output<typeof configSchema>;

/** Author-facing helper for whale.config.ts. Validation happens at load. */
export function defineConfig(config: WhaleConfigInput): WhaleConfigInput {
  return config;
}

/** Validate + apply defaults. Throws a readable error on bad config. */
export function resolveConfig(input: unknown = {}): WhaleConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid whale config:\n${issues}`);
  }
  return parsed.data;
}
