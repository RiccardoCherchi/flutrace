import { expect, it } from "vitest";
import { decodeJwt, findJwts } from "./jwt.ts";

const part = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "example", name: "Niccolò", exp: 1700000000 })}.c2lnbmF0dXJl`;

it("decodes UTF-8 header and payload without pretending to verify the signature", () => {
  expect(decodeJwt(token)).toEqual({
    header: { alg: "HS256", typ: "JWT" },
    payload: { sub: "example", name: "Niccolò", exp: 1700000000 },
  });
  expect(
    decodeJwt(`${part({ alg: "none" })}.${part({ sub: "test" })}.`)?.payload
      .sub,
  ).toBe("test");
});
it("rejects malformed, encrypted, oversized, non-object and invalid UTF-8 tokens", () => {
  for (const value of [
    "a.b.c",
    "aaa.bbb.ccc.ddd.eee",
    `${part([])}.${part({})}.sig`,
    `${part({})}.e30_.sig`,
    `${part({})}.${part({})}.${"a".repeat(40000)}`,
  ]) {
    expect(decodeJwt(value)).toBeUndefined();
  }
});
it("finds complete tokens in headers, JSON, and URLs without matching JWE prefixes", () => {
  const text = `Bearer ${token}\n{"jwt":"${token}"} https://example.test/?token=${token}&x=1`;
  const found = findJwts(text);
  expect(found).toHaveLength(3);
  expect(found.map((match) => text.slice(match.start, match.end))).toEqual([
    token,
    token,
    token,
  ]);
  expect(findJwts(`${token}.more.parts`)).toEqual([]);
  expect(findJwts("not.a.jwt")).toEqual([]);
});
