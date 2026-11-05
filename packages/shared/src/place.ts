import { z } from "zod";

export const PLACE_CATEGORIES = ["museum", "gallery", "restaurant", "viewpoint", "other"] as const;
export const PlaceCategorySchema = z.enum(PLACE_CATEGORIES);
export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;

export const TICKET_TYPES = ["free", "paid", "reduced"] as const;
export const TicketTypeSchema = z.enum(TICKET_TYPES);
export type TicketType = z.infer<typeof TicketTypeSchema>;

export const HoursEntrySchema = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  start: z.string().describe("HH:MM, 24-hour local time"),
  end: z.string().describe("HH:MM, 24-hour local time"),
});
export type HoursEntry = z.infer<typeof HoursEntrySchema>;

export const TicketSchema = z.object({
  type: TicketTypeSchema,
  price: z
    .string()
    .nullable()
    .describe("Price in the place's currency, including the currency, e.g. 20USD. null if free."),
  condition: z
    .string()
    .nullable()
    .describe("null, or the condition in few words, e.g. 'under 18 free', 'on tuesday it is free'"),
});
export type Ticket = z.infer<typeof TicketSchema>;

/**
 * What a step 2 bot stores for one place (plan 04, step 2). Anything the bot cannot find is null,
 * never invented. Schema length limits are enforced client-side by the SDK, so an over-long
 * description counts as a failed extraction.
 */
export const PlaceDataSchema = z.object({
  place: z.string(),
  category: PlaceCategorySchema,
  address: z.string().nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  hours: z.array(HoursEntrySchema),
  description: z.string().max(120).nullable(),
  visit_duration_min: z.number().int().positive().nullable(),
  google_place_id: z.string().nullable(),
  google_maps_url: z.string().nullable(),
  place_image_url: z.string().nullable(),
  tickets: z.array(TicketSchema),
  needs_reservation: z.boolean().nullable(),
});
export type PlaceData = z.infer<typeof PlaceDataSchema>;

export const SourceSchema = z.object({ url: z.string(), title: z.string().nullable() });
export type Source = z.infer<typeof SourceSchema>;
