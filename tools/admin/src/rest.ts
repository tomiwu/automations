export type Row = Record<string, unknown>;

export interface RestClient {
  insert(table: string, rows: readonly Row[]): Promise<Row[]>;
  select(table: string, query?: string): Promise<Row[]>;
  update(table: string, query: string, patch: Row): Promise<Row[]>;
}

export interface RestOptions {
  url: string;
  key: string;
  fetch: typeof fetch;
}

/** A small PostgREST client. It uses the service role key of the owner. */
export function createRestClient(options: RestOptions): RestClient {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: options.key,
    authorization: `Bearer ${options.key}`,
    "content-type": "application/json",
    prefer: "return=representation",
  };

  async function call(method: string, path: string, body?: unknown): Promise<Row[]> {
    const response = await options.fetch(`${base}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path.split("?")[0]} failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as Row[];
  }

  return {
    insert: (table, rows) => call("POST", table, rows),
    select: (table, query = "select=*") => call("GET", `${table}?${query}`),
    update: (table, query, patch) => call("PATCH", `${table}?${query}`, patch),
  };
}
