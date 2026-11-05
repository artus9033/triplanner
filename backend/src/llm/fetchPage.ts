import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  PAGE_FETCH_TIMEOUT_MS,
  PAGE_MAX_BYTES,
  PAGE_MAX_CHARS,
  PAGE_MAX_LINKS,
  PAGE_MAX_REDIRECTS,
  PAGE_USER_AGENT,
} from "../config/llm";

export type FetchedPage = { url: string; title: string | null; text: string };

export type PageDeps = {
  fetch: typeof fetch;
  resolve: (hostname: string) => Promise<string[]>;
};

const defaultDeps: PageDeps = {
  fetch: (...args) => fetch(...args),
  resolve: async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address),
};

/** A failure the model is told about, so it can try another page. */
export class PageError extends Error {}

const ipv4IsPublic = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
};

/** False for loopback, private, link-local and other addresses that are not on the internet. */
export const isPublicAddress = (ip: string): boolean => {
  const address = ip.toLowerCase();
  if (isIP(address) === 4) return ipv4IsPublic(address);
  if (isIP(address) !== 6) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return ipv4IsPublic(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1] as string, 16), parseInt(hex[2] as string, 16)];
    return ipv4IsPublic(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !(
    address === "::" ||
    address === "::1" ||
    /^f[cd]/.test(address) ||
    /^fe[89ab]/.test(address) ||
    /^ff/.test(address)
  );
};

/**
 * The model chooses these URLs, and it reads untrusted pages, so nothing inside this machine or its
 * network may be reachable. Each redirect hop is checked again.
 */
const assertPublicUrl = async (raw: string, deps: PageDeps): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PageError("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageError("Only http and https pages can be fetched.");
  }
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) {
    throw new PageError("That URL is not allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await deps.resolve(host);
  } catch {
    throw new PageError("That site could not be found.");
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new PageError("That URL is not allowed.");
  }
  return url;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  euro: "€",
  pound: "£",
  rsquo: "’",
  lsquo: "‘",
  eacute: "é",
  egrave: "è",
  agrave: "à",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const value = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : null;
};

/** Page text for the model, plus links and the share image so it can navigate and fill those in. */
export const htmlToPage = (html: string, url: string): Omit<FetchedPage, "url"> => {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const image = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) =>
      /og:image/i.test(attribute(tag, "property") ?? "") ? attribute(tag, "content") : null,
    )
    .find(Boolean);

  const links = new Map<string, string>();
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = attribute(match[0], "href");
    if (!href) continue;
    try {
      const target = new URL(href, url);
      if (target.protocol !== "http:" && target.protocol !== "https:") continue;
      target.hash = "";
      const label = decodeEntities(match[1]?.replace(/<[^>]+>/g, " ") ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (label && !links.has(target.href)) links.set(target.href, label);
    } catch {
      // Not a usable link.
    }
    if (links.size >= PAGE_MAX_LINKS) break;
  }

  const body = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section)\b[^>]*>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const extras = [
    ...(image ? [`Image: ${image}`] : []),
    ...(links.size ? ["Links:", ...[...links].map(([href, label]) => `- ${label}: ${href}`)] : []),
  ].join("\n");
  const room = Math.max(0, PAGE_MAX_CHARS - extras.length - 1);
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || null : null,
    text: [body.slice(0, room), extras].filter(Boolean).join("\n"),
  };
};

/** Reads at most `limit` bytes, so one huge page cannot exhaust memory or the token budget. */
const readLimited = async (res: Response, limit: number): Promise<string> => {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total >= limit) {
      await reader.cancel();
      break;
    }
  }
  return text;
};

/** Fetches one public web page as text. Throws PageError with text meant for the model. */
export const fetchPage = async (
  raw: string,
  { signal, deps = defaultDeps }: { signal?: AbortSignal; deps?: PageDeps } = {},
): Promise<FetchedPage> => {
  const timeout = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = raw;
  for (let hop = 0; hop <= PAGE_MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, deps);
    let res: Response;
    try {
      res = await deps.fetch(url.href, {
        redirect: "manual",
        signal: combined,
        headers: {
          "user-agent": PAGE_USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        },
      });
    } catch (err) {
      // The caller's own budget ending is not something the model can work around.
      if (signal?.aborted) throw err;
      throw new PageError(timeout.aborted ? "The page took too long." : "The page did not load.");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new PageError(`The page returned status ${res.status}.`);
      current = new URL(location, url).href;
      continue;
    }
    if (!res.ok) throw new PageError(`The page returned status ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/(html|plain)|application\/xhtml/i.test(type)) {
      throw new PageError("That address is not a web page.");
    }
    const body = await readLimited(res, PAGE_MAX_BYTES);
    const page = htmlToPage(body, url.href);
    if (!page.text) throw new PageError("The page has no readable text.");
    return { url: url.href, ...page };
  }
  throw new PageError("The page redirected too many times.");
};
