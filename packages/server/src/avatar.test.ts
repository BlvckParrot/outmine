import { afterEach, expect, mock, test } from "bun:test";
import { fetchHandleAvatar } from "./avatar";

const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("no proxy origin configured means no fetch and no avatar", async () => {
  const spy = mock(() => {
    throw new Error("fetch should not be called");
  });
  globalThis.fetch = spy as unknown as typeof fetch;

  expect(await fetchHandleAvatar("jack", "")).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

test("a non-ok response (fallback=false biting on an unknown handle) yields no avatar", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  expect(await fetchHandleAvatar("nobody", "https://fake.example")).toBeNull();
});

test("bytes that are not a usable image yield no avatar", async () => {
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
  expect(await fetchHandleAvatar("jack", "https://fake.example")).toBeNull();
});

test("a network failure yields no avatar rather than throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect(await fetchHandleAvatar("jack", "https://fake.example")).toBeNull();
});

test("a valid image is resized and re-encoded, same as an uploaded icon", async () => {
  globalThis.fetch = (async () => new Response(PNG_1X1, { status: 200 })) as unknown as typeof fetch;
  const icon = await fetchHandleAvatar("jack", "https://fake.example");
  expect(icon).not.toBeNull();
  expect(icon!.length).toBeGreaterThan(0);
});
