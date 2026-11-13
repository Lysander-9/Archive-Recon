import type { HttpResponseLike } from "../../src/application/ports";
import type { RawArchiveRecord } from "../../src/domain/record";

export function rawRecord(
  url: string,
  overrides: Partial<RawArchiveRecord> = {},
): RawArchiveRecord {
  return {
    url,
    statusCode: "200",
    length: "100",
    fileType: "text/html",
    timestamp: "2024-01-02",
    rawTimestamp: "20240102030405",
    source: "wayback",
    ...overrides,
  };
}

export function jsonResponse(data: unknown): HttpResponseLike {
  return {
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

export function textResponse(text: string, status = 200): HttpResponseLike {
  return {
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export function fakeTransport(responses: Array<HttpResponseLike | Error>): {
  transport: (url: string, init?: { signal?: AbortSignal }) => Promise<HttpResponseLike>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    transport: async (url) => {
      urls.push(url);
      const item = responses[Math.min(urls.length - 1, responses.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    },
  };
}
