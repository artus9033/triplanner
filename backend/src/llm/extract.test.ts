import { PlaceDataSchema, type PlaceData } from "@triplanner/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SEARCH_EFFORT } from "../config/llm";
import { setAnthropicClientForTest } from "./client";
import { LlmError } from "./errors";
import { extractStructured, normalizeEnums } from "./extract";
import { fakeClient, message, type Reply } from "./testApi";

const validPlace: PlaceData = {
  place: "Louvre",
  category: "museum",
  address: null,
  lat: 48.86,
  lng: 2.33,
  phone: null,
  website: null,
  hours: [],
  description: "A museum.",
  visit_duration_min: null,
  google_place_id: null,
  google_maps_url: null,
  place_image_url: null,
  tickets: [{ type: "paid", price: "22EUR", condition: null }],
  needs_reservation: null,
};

const text = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

const run = <S extends z.ZodType>(schema: S, replies: Reply[]) => {
  const { client, requests } = fakeClient(replies);
  setAnthropicClientForTest(client);
  return { promise: extractStructured(schema, { system: "sys", text: "notes" }), requests };
};

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "no error",
    (e: LlmError) => e.code,
  );

afterEach(() => setAnthropicClientForTest(null));

describe("extractStructured request", () => {
  it("sends no tools, no forbidden params, and the effort and format", async () => {
    const { promise, requests } = run(PlaceDataSchema, [message(text(validPlace))]);
    await promise;
    const { body } = requests[0]!;
    for (const key of [
      "tools",
      "tool_choice",
      "temperature",
      "top_p",
      "top_k",
      "thinking",
      "fallbacks",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.output_config.effort).toBe(SEARCH_EFFORT);
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("SDK 1.5.0 strips length and range limits from the wire schema into the description", async () => {
    const { promise, requests } = run(PlaceDataSchema, [message(text(validPlace))]);
    await promise;
    const wire = requests[0]!.body.output_config.format.schema;
    const wireText = JSON.stringify(wire);
    expect(wireText).not.toMatch(/"(maxLength|minimum|maximum|exclusiveMinimum)"/);
    expect(wire.additionalProperties).toBe(false);
    const description = wire.properties.description.anyOf[0];
    expect(description.type).toBe("string");
    expect(description.description).toContain("maxLength: 120");
    const lat = wire.properties.lat.anyOf[0];
    expect(lat.description).toMatch(/minimum: -90.*maximum: 90/);
    // `enum` is treated the same way, which is why enums are compared in code.
    expect(wire.properties.category.enum).toBeUndefined();
    expect(wire.properties.category.description).toContain("enum:");
  });
});

describe("extractStructured results", () => {
  it("returns validated output", async () => {
    await expect(run(PlaceDataSchema, [message(text(validPlace))]).promise).resolves.toEqual(
      validPlace,
    );
  });

  it("a description over 120 characters is a failed extraction, not truncated", async () => {
    const reply = message(text({ ...validPlace, description: "x".repeat(121) }));
    await expect(codeOf(run(PlaceDataSchema, [reply]).promise)).resolves.toBe("extract_failed");
  });

  it("accepts exactly 120 characters", async () => {
    const description = "x".repeat(120);
    const reply = message(text({ ...validPlace, description }));
    await expect(run(PlaceDataSchema, [reply]).promise).resolves.toMatchObject({ description });
  });

  it("a latitude out of range is a failed extraction", async () => {
    const reply = message(text({ ...validPlace, lat: 91 }));
    await expect(codeOf(run(PlaceDataSchema, [reply]).promise)).resolves.toBe("extract_failed");
  });

  it("invalid JSON is a failed extraction", async () => {
    await expect(codeOf(run(PlaceDataSchema, [message(text("{not json"))]).promise)).resolves.toBe(
      "extract_failed",
    );
  });

  it("no text block means null parsed_output, a failed extraction", async () => {
    await expect(codeOf(run(PlaceDataSchema, [message({ content: [] })]).promise)).resolves.toBe(
      "extract_failed",
    );
  });

  it("compares enums case-insensitively", async () => {
    const reply = message(
      text({
        ...validPlace,
        category: "MUSEUM",
        tickets: [{ type: "Paid", price: "1USD", condition: null }],
      }),
    );
    await expect(run(PlaceDataSchema, [reply]).promise).resolves.toMatchObject({
      category: "museum",
      tickets: [{ type: "paid" }],
    });
  });

  it("an enum value outside the set is still a failed extraction", async () => {
    const reply = message(text({ ...validPlace, category: "park" }));
    await expect(codeOf(run(PlaceDataSchema, [reply]).promise)).resolves.toBe("extract_failed");
  });

  it("stop_reason wins over parsing: refusal text that is not JSON is a refusal", async () => {
    const reply = message({ ...text("I can't help with that."), stop_reason: "refusal" });
    await expect(codeOf(run(PlaceDataSchema, [reply]).promise)).resolves.toBe("refusal");
  });

  it("stop_reason wins over parsing: truncated JSON is max_tokens", async () => {
    const reply = message({ ...text('{"place": "Lou'), stop_reason: "max_tokens" });
    await expect(codeOf(run(PlaceDataSchema, [reply]).promise)).resolves.toBe("max_tokens");
  });
});

describe("normalizeEnums", () => {
  const tree = z.toJSONSchema(
    z.object({ a: z.enum(["x", "Y"]).nullable(), list: z.array(z.object({ b: z.enum(["z"]) })) }),
  );

  it("handles nullable and nested enums and leaves other values alone", () => {
    expect(normalizeEnums({ a: "y", list: [{ b: "Z" }] }, tree as never)).toEqual({
      a: "Y",
      list: [{ b: "z" }],
    });
    expect(normalizeEnums({ a: null, list: [] }, tree as never)).toEqual({ a: null, list: [] });
    expect(normalizeEnums({ a: "other", list: [] }, tree as never)).toEqual({
      a: "other",
      list: [],
    });
  });
});
