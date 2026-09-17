export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class RisexHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(`${this.baseUrl}${path}`);
    } catch {
      throw new Error(`RISEx API base URL is not valid: ${this.baseUrl}`);
    }
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    return this.parse("GET", path, response);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return this.parse("POST", path, response);
  }

  private async parse(
    method: "GET" | "POST",
    path: string,
    response: Response,
  ): Promise<unknown> {
    const text = await response.text();
    const payload = parseResponseBody(text);
    if (!response.ok) {
      throw new Error(
        `RISEx ${method} ${path} failed with HTTP ${response.status}${text ? `: ${truncateForError(text)}` : ""}`,
      );
    }
    return payload;
  }
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function parseResponseBody(text: string): JsonValue | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function truncateForError(value: string, maxLength = 400): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
