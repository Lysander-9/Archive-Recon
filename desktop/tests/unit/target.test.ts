import { expect, test } from "@playwright/test";

import { normalizeTarget } from "../../src/domain/target";

test.describe("target normalization (T1)", () => {
  test("accepts plain, wildcard, scheme and surrounding spaces", () => {
    const cases: Array<[string, string, boolean]> = [
      ["example.com", "example.com", false],
      ["EXAMPLE.com", "example.com", false],
      ["*.example.com", "example.com", true],
      ["https://Example.com/", "example.com", false],
      ["http://example.com", "example.com", false],
      ["https://*.example.com/", "example.com", true],
      [" example.com ", "example.com", false],
    ];
    for (const [input, host, wildcard] of cases) {
      const result = normalizeTarget(input);
      expect(result.ok, input).toBe(true);
      if (result.ok) {
        expect(result.scope.host).toBe(host);
        expect(result.scope.wildcard).toBe(wildcard);
        expect(result.scope.match).toBe("host-and-subdomains");
      }
    }
  });

  test("rejects userinfo and internal whitespace (four reported inputs)", () => {
    const cases: Array<[string, string]> = [
      ["user:pass@example.com", "用户信息"],
      ["https://user:pass@example.com/", "用户信息"],
      ["exa mple.com", "空白"],
      ["example .com", "空白"],
    ];
    for (const [input, fragment] of cases) {
      const result = normalizeTarget(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message).toContain(fragment);
    }
  });

  test("rejects path, query, fragment, port, empty and invalid labels", () => {
    const cases: Array<[string, string]> = [
      ["", "请输入目标域名"],
      ["   ", "请输入目标域名"],
      ["example.com/path", "路径"],
      ["example.com?x=1", "路径"],
      ["example.com#frag", "路径"],
      ["example.com:8080", "端口"],
      ["example.com:bad", "端口格式"],
      ["ftp://example.com", "域名格式无效"],
      ["http://", "域名格式无效"],
      ["example.com.", "域名格式无效"],
      ["-bad.example.com", "域名格式无效"],
      ["bad-.example.com", "域名格式无效"],
    ];
    for (const [input, fragment] of cases) {
      const result = normalizeTarget(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message).toContain(fragment);
    }
  });

  test("wildcard does not bypass userinfo rejection", () => {
    const result = normalizeTarget("https://user:pass@*.example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("用户信息");
  });

  test("rejects percent-encoded hosts, backslashes and control characters before parsing", () => {
    const cases = [
      "exa%6Dple.com",
      "%65xample.com",
      "https://example.com\\@evil.test",
      "example.com\u0000.evil",
    ];
    for (const input of cases) {
      const result = normalizeTarget(input);
      expect(result.ok, input).toBe(false);
    }
  });
});
