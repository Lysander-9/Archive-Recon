import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServer {
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

const WAYBACK_ROWS = [
  ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
  ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "10"],
  ["k2", "20240103040506", "https://example.com/b", "text/html; charset=UTF-8", "200", "D2", "0"],
  ["k3", "20240104050607", "https://www.example.com/c", "application/pdf", "301", "D3", "42"],
  ["k4", "20240105060708", "https://example.com/a", "text/html", "200", "D4", "99"],
];

const CC_NDJSON = [
  '{"url":"https://example.com/cc/1","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}',
  '{"url":"https://example.com/cc/2","status":"301","mime":"text/html","length":"2","timestamp":"20240103040506"}',
  "this line is not valid JSON and must be reported as a parse issue",
].join("\n");

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  let baseUrl = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
    requests.push(url.toString());
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (url.pathname === "/wayback") {
      response.end(JSON.stringify(WAYBACK_ROWS));
      return;
    }
    if (url.pathname === "/cc/collinfo.json") {
      response.end(
        JSON.stringify([
          {
            id: "CC-MAIN-2024-10",
            "cdx-api": `${baseUrl}/cc/CC-MAIN-2024-10-index`,
            from: "20240101000000",
            to: "20240301000000",
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/cc/CC-MAIN-2024-10-index") {
      if (url.searchParams.get("showNumPages") === "true") {
        response.end(JSON.stringify({ pages: 3 }));
        return;
      }
      const page = Number(url.searchParams.get("page") ?? "0");
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      if (page === 0) {
        response.end(CC_NDJSON);
        return;
      }
      if (page === 1) {
        setTimeout(() => response.end(
          '{"url":"https://example.com/cc/3","status":"200","mime":"text/html","length":"3","timestamp":"20240104050607"}',
        ), 800);
        return;
      }
      response.end("");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
