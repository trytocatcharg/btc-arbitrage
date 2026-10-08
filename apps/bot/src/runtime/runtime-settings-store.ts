import type { BotConfig } from "@btc-arbitrage/config";
import { botRuntimeOverrides } from "@btc-arbitrage/db";
import type { getDb } from "@btc-arbitrage/db";
import { sql } from "drizzle-orm";
import {
  applyAutoConfirm,
  applyCooldownMinutes,
  applyMarginUsd,
  applyMinSpreadUsd,
} from "./runtime-settings.js";
import type { RuntimeSettingChange, RuntimeSettingKey } from "./runtime-settings.js";

type Db = Awaited<ReturnType<typeof getDb>>;

// Persistence layer for runtime-adjustable settings. Values are stored as
// strings in bot_runtime_overrides and go through the same appliers as the
// Telegram runtime commands, so validation and the notional recompute stay
// consistent between in-memory and persisted overrides.

/** Current value of a runtime setting, stringified for persistence. */
function readSettingValue(config: BotConfig, key: RuntimeSettingKey): string {
  switch (key) {
    case "cooldownMinutes":
      return String(Math.round(config.telegram.alertCooldownMs / 60_000));
    case "minSpreadUsd":
      return config.minPriceDiffUsd;
    case "marginUsd":
      return config.openTrade.marginUsd;
    case "autoConfirm":
      return config.openTrade.autoConfirm ? "true" : "false";
  }
}

/** Upsert one runtime override so it survives bot restarts. Rethrows on failure. */
export async function persistRuntimeOverride(
  db: Db,
  config: BotConfig,
  key: RuntimeSettingKey,
): Promise<void> {
  try {
    await db
      .insert(botRuntimeOverrides)
      .values({
        settingKey: key,
        settingValue: readSettingValue(config, key),
      })
      .onDuplicateKeyUpdate({
        set: {
          settingValue: readSettingValue(config, key),
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    console.error("Failed to persist runtime override", { key, error });
    throw error;
  }
}

/** Parse a stored value back into the applier's argument, or null if invalid. */
function parseStoredValue(
  key: RuntimeSettingKey,
  raw: string,
): number | boolean | null {
  switch (key) {
    case "cooldownMinutes":
    case "minSpreadUsd":
    case "marginUsd": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
    case "autoConfirm":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return null;
  }
}

/**
 * Apply persisted overrides onto the live config at boot. Unknown keys and
 * invalid stored values are skipped with a warning — a bad row must never
 * prevent the bot from starting.
 */
export async function applyPersistedRuntimeOverrides(
  db: Db,
  config: BotConfig,
): Promise<RuntimeSettingChange[]> {
  const rows = await db.select().from(botRuntimeOverrides);
  const changes: RuntimeSettingChange[] = [];

  for (const row of rows) {
    const key = row.settingKey as RuntimeSettingKey;
    const knownKeys: RuntimeSettingKey[] = [
      "cooldownMinutes",
      "minSpreadUsd",
      "marginUsd",
      "autoConfirm",
    ];
    if (!knownKeys.includes(key)) {
      console.warn("Skipping unknown persisted runtime override", {
        settingKey: row.settingKey,
      });
      continue;
    }

    const value = parseStoredValue(key, row.settingValue);
    if (value === null) {
      console.warn("Skipping invalid persisted runtime override", {
        settingKey: row.settingKey,
        settingValue: row.settingValue,
      });
      continue;
    }

    try {
      switch (key) {
        case "cooldownMinutes":
          changes.push(applyCooldownMinutes(config, value as number));
          break;
        case "minSpreadUsd":
          changes.push(applyMinSpreadUsd(config, value as number));
          break;
        case "marginUsd":
          changes.push(applyMarginUsd(config, value as number));
          break;
        case "autoConfirm":
          changes.push(applyAutoConfirm(config, value as boolean));
          break;
      }
    } catch (error) {
      console.warn("Skipping out-of-range persisted runtime override", {
        settingKey: row.settingKey,
        settingValue: row.settingValue,
        error,
      });
    }
  }

  return changes;
}
