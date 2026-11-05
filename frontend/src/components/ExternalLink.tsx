import { Link } from "@mui/material";
import type { ReactNode } from "react";
import { safeHttpUrl } from "../lib/safeUrl";

/** Renders nothing unless the URL is http or https. Web-derived URLs must go through this. */
export function ExternalLink({ href, children }: { href: unknown; children: ReactNode }) {
  const safe = safeHttpUrl(href);
  if (!safe) return null;
  return (
    <Link href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}
