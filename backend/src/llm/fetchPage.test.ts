import { describe, expect, it, vi } from "vitest";
import { PAGE_MAX_CHARS } from "../config/llm";
import { fetchPage, htmlToPage, isPublicAddress, PageError, type PageDeps } from "./fetchPage";

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

const deps = (
  fetchImpl: (url: string) => Response | Promise<Response>,
  addresses: Record<string, string[]> = {},
): PageDeps & { fetch: ReturnType<typeof vi.fn> } => ({
  fetch: vi.fn(async (input: any) => fetchImpl(String(input))) as never,
  resolve: async (host) => addresses[host] ?? ["93.184.216.34"],
});

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.18.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "not-an-ip",
  ])("rejects %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "accepts %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );
});

describe("fetchPage address rules", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://localhost:3000/api/trips",
    "http://user:pw@example.com/",
    "ftp://example.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("blocks %s without sending a request", async (url) => {
    const d = deps(() => html("x"), { localhost: ["127.0.0.1"] });
    await expect(fetchPage(url, { deps: d })).rejects.toBeInstanceOf(PageError);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("blocks a public name that resolves to a private address, even with one public", async () => {
    const d = deps(() => html("x"), { "evil.example": ["93.184.216.34", "10.0.0.5"] });
    await expect(fetchPage("https://evil.example/", { deps: d })).rejects.toThrow(/not allowed/);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect into the private network", async () => {
    const d = deps(() => html("", 302, { location: "http://169.254.169.254/" }));
    await expect(fetchPage("https://example.com/", { deps: d })).rejects.toThrow(/not allowed/);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("follows relative redirects, reports the final URL, and stops on a loop", async () => {
    const d = deps((url) =>
      url.endsWith("/a") ? html("", 301, { location: "/b" }) : html("<p>Open daily</p>"),
    );
    const page = await fetchPage("https://example.com/a", { deps: d });
    expect(page.url).toBe("https://example.com/b");
    expect(page.text).toContain("Open daily");
    const loop = deps(() => html("", 302, { location: "/again" }));
    await expect(fetchPage("https://example.com/", { deps: loop })).rejects.toThrow(/too many/);
  });

  it("tells the model about failures rather than throwing unknown errors", async () => {
    const run = (r: Response) => fetchPage("https://example.com/", { deps: deps(() => r) });
    await expect(run(html("", 404))).rejects.toThrow(/status 404/);
    await expect(run(html("", 403))).rejects.toThrow(/status 403/);
    await expect(
      run(new Response("%PDF", { headers: { "content-type": "application/pdf" } })),
    ).rejects.toThrow(/not a web page/);
    await expect(run(html("<script>only()</script>"))).rejects.toThrow(/no readable text/);
    const down: PageDeps = {
      fetch: () => Promise.reject(new Error("econnreset")),
      resolve: async () => ["93.184.216.34"],
    };
    await expect(fetchPage("https://example.com/", { deps: down })).rejects.toThrow(/did not load/);
  });

  it("rethrows when the caller's own budget ended, so research stops", async () => {
    const d: PageDeps = {
      fetch: () => Promise.reject(new DOMException("aborted", "AbortError")),
      resolve: async () => ["93.184.216.34"],
    };
    await expect(
      fetchPage("https://example.com/", { deps: d, signal: AbortSignal.abort() }),
    ).rejects.not.toBeInstanceOf(PageError);
  });

  it("does not read past the byte limit", async () => {
    const huge = "<p>" + "x".repeat(5_000_000) + "</p>";
    const page = await fetchPage("https://example.com/", { deps: deps(() => html(huge)) });
    expect(page.text.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
  });
});

describe("htmlToPage", () => {
  const url = "https://example.com/visit/";

  it("keeps readable text and drops scripts, styles and comments", () => {
    const { title, text } = htmlToPage(
      `<html><head><title> The &amp; Museum </title><style>p{color:red}</style></head>
       <body><!-- secret --><script>steal()</script><h1>Hours</h1><p>Mon&nbsp;9&ndash;18</p>
       <table><tr><td>Adult</td><td>&euro;20</td></tr></table></body></html>`,
      url,
    );
    expect(title).toBe("The & Museum");
    expect(text).toContain("Hours\n");
    expect(text).toContain("Mon 9–18");
    expect(text).toContain("Adult | €20");
    expect(text).not.toMatch(/steal|secret|color:red/);
  });

  it("lists absolute http links for navigation and skips the others", () => {
    const { text } = htmlToPage(
      `<a href="tickets">Tickets</a> <a href="https://o.example/x#a"><b>Other</b></a>
       <a href="javascript:evil()">Bad</a> <a href="mailto:a@b.c">Mail</a> <a href="/empty"></a>`,
      url,
    );
    expect(text).toContain("- Tickets: https://example.com/visit/tickets");
    expect(text).toContain("- Other: https://o.example/x");
    expect(text).not.toMatch(/evil|mailto|\/empty/);
  });

  it("reports the share image and never exceeds the size limit", () => {
    const { text } = htmlToPage(
      `<meta property="og:image" content="https://cdn.example/a.jpg"><p>${"y".repeat(99_999)}</p>`,
      url,
    );
    expect(text).toContain("Image: https://cdn.example/a.jpg");
    expect(text.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
  });
});
