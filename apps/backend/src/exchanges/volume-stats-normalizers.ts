import { formatDecimal, parseDecimal } from '@btc-arbitrage/domain';
import type { RawVolumeStats, VenueVolumeSnapshot, VolumeTotalsSnapshot } from './volume-stats-service.js';

export interface VenueVolumeDto {
  exchangeId: string;
  volumeUsd: string;
}

export interface VolumeTotalsDto {
  totalUsd: string;
  byVenue: VenueVolumeDto[];
}

export interface VolumeStatsResponseDto {
  generatedAt: string;
  lifetime: VolumeTotalsDto;
  windows: {
    '24h': VolumeTotalsDto;
    '7d': VolumeTotalsDto;
    '30d': VolumeTotalsDto;
  };
}

/** Decimals are emitted as strings per the `formatDecimal` convention (design D7). */
export function normalizeVolumeStats(raw: RawVolumeStats): VolumeStatsResponseDto {
  return {
    generatedAt: raw.generatedAt.toISOString(),
    lifetime: normalizeTotals(raw.lifetime),
    windows: {
      '24h': normalizeTotals(raw.windows['24h']),
      '7d': normalizeTotals(raw.windows['7d']),
      '30d': normalizeTotals(raw.windows['30d'])
    }
  };
}

function normalizeTotals(snapshot: VolumeTotalsSnapshot): VolumeTotalsDto {
  return {
    totalUsd: formatUsdDecimal(snapshot.totalUsd),
    byVenue: snapshot.byVenue.map(normalizeVenueVolume)
  };
}

function normalizeVenueVolume(row: VenueVolumeSnapshot): VenueVolumeDto {
  return {
    exchangeId: row.exchangeId,
    volumeUsd: formatUsdDecimal(row.volumeUsd)
  };
}

function formatUsdDecimal(rawDecimal: string): string {
  return formatDecimal(parseDecimal(rawDecimal, 'volumeUsd'), 2);
}
