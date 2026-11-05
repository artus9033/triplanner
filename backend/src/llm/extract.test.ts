import { afterEach, describe, expect, it } from "vitest";
import { PlaceDataSchema } from "@triplanner/shared";
import { z } from "zod";
import { SEARCH_EFFORT } from "../config/llm";
import { setApexFetchForTest } from "./client";
import { extractStructured, normalizeEnums } from "./extract";
import { chat, fakeFetch, jsonResponse, type Reply } from "./testApi";

const Schema = z.object({
  city: z.string(),
  kind: z.enum(["museum", "other"]),
  note: z.string().max(10).nullable(),
});
const good = { city: "Paris", kind: "museum", note: null };

const run = (replies: Reply[]) => {
  const fake = fakeFetch(replies);
  setApexFetchForTest(fake.fetchFn);
  return {
    requests: fake.requests,
    result: extractStructured(Schema, { system: "sys", text: "notes" }),
  };
};
const json = (value: unknown) => chat({ content: `\n\n${JSON.stringify(value)}` });

afterEach(() => setApexFetchForTest(null));

describe("extractStructured", () => {
  it("sends a JSON schema, effort, and no tools", async () => {
    const { requests, result } = run([json(good)]);
    expect(await result).toEqual(good);
    const { body } = requests[0]!;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.properties.kind.enum).toEqual([
      "museum",
      "other",
    ]);
    expect(body.reasoning_effort).toBe(SEARCH_EFFORT);
    expect(body.tools).toBeUndefined();
  });

  it("compares enums without regard to case", async () => {
    expect(await run([json({ ...good, kind: "MUSEUM" })]).result).toMatchObject({ kind: "museum" });
  });

  it("fails on an unknown enum, a broken limit, a wrong type, or text that is not JSON", async () => {
    for (const reply of [
      json({ ...good, kind: "park" }),
      json({ ...good, note: "x".repeat(11) }),
      json({ ...good, city: 5 }),
      chat({ content: "Sorry, no." }),
    ]) {
      await expect(run([reply]).result).rejects.toMatchObject({ code: "extract_failed" });
    }
  });

  it("checks stop reasons before parsing", async () => {
    await expect(
      run([chat({ finish: "content_filter", content: "no" })]).result,
    ).rejects.toMatchObject({ code: "refusal" });
    await expect(run([chat({ finish: "length", content: '{"ci' })]).result).rejects.toMatchObject({
      code: "max_tokens",
    });
  });

  it("reports usage and maps API errors", async () => {
    const seen: unknown[] = [];
    setApexFetchForTest(fakeFetch([json(good)]).fetchFn);
    await extractStructured(Schema, {
      system: "s",
      text: "t",
      onUsage: (usage) => seen.push(usage),
    });
    expect(seen).toEqual([{ input_tokens: 10, output_tokens: 5, pages_fetched: 0 }]);
    await expect(
      run([jsonResponse({ error: { message: "x" } }, 400)]).result,
    ).rejects.toMatchObject({ code: "api" });
  });

  it("produces a schema for PlaceData that keeps the description limit client-side", () => {
    const tooLong = { description: "x".repeat(121) };
    expect(PlaceDataSchema.shape.description.safeParse(tooLong.description).success).toBe(false);
  });
});

describe("normalizeEnums", () => {
  it("reaches nested arrays and nullable values", () => {
    const schema = z.toJSONSchema(
      z.object({
        items: z.array(z.object({ t: z.enum(["free", "paid"]) })),
        k: z.enum(["a"]).nullable(),
      }),
    ) as never;
    expect(normalizeEnums({ items: [{ t: "PAID" }], k: "A" }, schema)).toEqual({
      items: [{ t: "paid" }],
      k: "a",
    });
    expect(normalizeEnums({ items: [], k: null }, schema)).toEqual({ items: [], k: null });
  });
});
