import { Alert, Button, Checkbox, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import type { PlaceProposal, Trip } from "@triplanner/shared";
import { useState } from "react";
import { useAction } from "../lib/useAction";
import { useTripStore } from "../store";
import { ExternalLink } from "./ExternalLink";

const LINK_TEXT = { google_maps: "Google Maps", website: "Website" } as const;

function Option({
  proposal,
  selected,
  onToggle,
}: {
  proposal: PlaceProposal;
  selected: boolean;
  onToggle: () => void;
}) {
  const inputId = `proposal-${proposal.id}`;
  const whyId = `${inputId}-why`;
  return (
    <div className="option" data-testid="place-option" data-selected={selected}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Checkbox
          id={inputId}
          checked={selected}
          onChange={onToggle}
          size="small"
          slotProps={{ input: { "aria-describedby": whyId } }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor={inputId} style={{ fontWeight: 600, cursor: "pointer" }}>
            {proposal.name}
          </label>{" "}
          <Chip label={proposal.category} size="small" variant="outlined" />
          <div id={whyId} className="plain-text">
            {proposal.why}
          </div>
          <ExternalLink href={proposal.link}>
            {proposal.link_kind ? LINK_TEXT[proposal.link_kind] : "Link"}
          </ExternalLink>
        </div>
      </Stack>
    </div>
  );
}

export function Proposals({ trip }: { trip: Trip }) {
  const retryProposals = useTripStore((s) => s.retryProposals);
  const confirmProposals = useTripStore((s) => s.confirmProposals);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const retry = useAction();
  const confirm = useAction();
  const { status, items, error } = trip.proposals;
  const named = trip.state.named_places;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const nothingToConfirm = selected.size === 0 && named.length === 0;
  const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);

  return (
    <section aria-label="Choose places">
      <Typography variant="h2" gutterBottom>
        Choose your places
      </Typography>

      {(status === "running" || status === "idle") && (
        <div role="status">
          <Typography gutterBottom>
            {status === "running"
              ? "Searching the web for places that match your plans. This can take a minute."
              : "Getting ready to search for places."}
          </Typography>
          <LinearProgress aria-label="Searching for places" />
        </div>
      )}

      {status === "failed" && (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              disabled={retry.pending}
              onClick={() => void retry.run(() => retryProposals(trip.id))}
            >
              {retry.pending ? "Retrying..." : "Retry search"}
            </Button>
          }
        >
          The place search failed: {error ?? "no details were given."}
        </Alert>
      )}
      {retry.error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {retry.error}
        </Alert>
      )}

      {status === "ready" && (
        <>
          <Typography color="text.secondary" gutterBottom>
            Select the ones you want to visit. Earlier ones in the list get priority if time runs
            short.
          </Typography>
          {items.length === 0 && <Typography>The search did not find any places.</Typography>}
          <Stack spacing={1} role="group" aria-label="Proposed places" sx={{ mb: 2 }}>
            {items.map((proposal) => (
              <Option
                key={proposal.id}
                proposal={proposal}
                selected={selected.has(proposal.id)}
                onToggle={() => toggle(proposal.id)}
              />
            ))}
          </Stack>
          {named.length > 0 && (
            <Typography sx={{ mb: 2 }}>
              Always included, because you named them: {named.map((p) => p.name).join(", ")}.
            </Typography>
          )}
          <Button
            data-testid="places-confirm"
            variant="contained"
            disabled={nothingToConfirm || confirm.pending}
            onClick={() => void confirm.run(() => confirmProposals(trip.id, selectedIds))}
          >
            {confirm.pending ? "Confirming..." : "Confirm these places"}
          </Button>
          {nothingToConfirm && (
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Select at least one place to continue.
            </Typography>
          )}
          {confirm.error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {confirm.error}
            </Alert>
          )}
        </>
      )}
    </section>
  );
}
