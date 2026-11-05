/**
 * The only gate for links and images built from web-derived data. Returns a normalized href for
 * absolute http/https URLs, and null for everything else (javascript:, data:, relative paths,
 * URLs with embedded credentials).
 */
export const safeHttpUrl = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
};

export const urlHost = (href: string): string => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
};
