import { describe, expect, it, vi } from "vitest";
import { createHttpClient, parseCacheControlMaxAge } from "./httpClient";

describe("http client cache", () => {
  it("respects max-age for GET responses", async () => {
    expect(parseCacheControlMaxAge("public, max-age=60")).toBe(60);
    const fetchFn = vi.fn(async () => new Response("ok", { headers: { "Cache-Control": "max-age=60" } }));
    const client = createHttpClient({ fetchFn });
    await client.get("https://example.test");
    await client.get("https://example.test");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
