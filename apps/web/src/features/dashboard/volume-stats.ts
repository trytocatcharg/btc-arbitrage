import { getBackendApiBaseUrl } from "./exchange-balances.js";

export interface VenueVolume {
  exchangeId: string;
  volumeUsd: string;
}

export interface VolumeTotals {
  totalUsd: string;
  byVenue: VenueVolume[];
}

export interface VolumeStatsResponse {
  generatedAt: string;
  lifetime: VolumeTotals;
  windows: {
    "24h": VolumeTotals;
    "7d": VolumeTotals;
    "30d": VolumeTotals;
  };
}

export interface VolumeStatsState {
  stats?: VolumeStatsResponse;
  loading: boolean;
  error?: string;
}

export async function fetchVolumeStats(
  fetchImpl: typeof fetch = fetch,
): Promise<VolumeStatsResponse> {
  const baseUrl = getBackendApiBaseUrl();
  const response = await fetchImpl(`${baseUrl}/api/trades/volume-stats`, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Backend volume stats request failed with HTTP ${response.status}`,
    );
  }

  return response.json() as Promise<VolumeStatsResponse>;
}
