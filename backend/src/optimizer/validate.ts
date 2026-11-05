import type { TripInstance, TripSchedule } from "@triplanner/shared";

const TOLERANCE = 1e-6;

/**
 * Independent checker. It shares no code with the engines on purpose: it re-derives every constraint
 * from the instance. Returns one message per violation; empty means valid.
 */
export const validateSchedule = (instance: TripInstance, schedule: TripSchedule): string[] => {
  const errors: string[] = [];
  const placeById = new Map(instance.places.map((place) => [place.id, place]));
  const dayByNumber = new Map(instance.days.map((day) => [day.day, day]));
  const tau = (from: string, to: string): number => instance.tau[from]?.[to] ?? 0;

  const seen = new Set<string>();
  for (const item of schedule.items) {
    if (seen.has(item.placeId)) errors.push(`${item.placeId}: visited more than once`);
    seen.add(item.placeId);
  }

  let spend = 0;
  let travel = 0;
  let shortened = 0;
  for (const day of instance.days) {
    const items = schedule.items
      .filter((item) => item.day === day.day)
      .sort((a, b) => a.order - b.order);
    if (items.length > day.nMax) errors.push(`day ${day.day}: ${items.length} visits over the cap`);

    items.forEach((item, index) => {
      const label = `${item.placeId} on day ${day.day}`;
      const place = placeById.get(item.placeId);
      if (item.order !== index + 1) errors.push(`${label}: order ${item.order}, not ${index + 1}`);
      if (item.date !== day.date) errors.push(`${label}: wrong date ${item.date}`);
      if (!place) {
        errors.push(`${label}: not in the instance`);
        return;
      }

      const expectedDur = item.shortened ? place.dur - place.delta : place.dur;
      if (item.dur !== expectedDur)
        errors.push(`${label}: duration ${item.dur}, not ${expectedDur}`);
      if (Math.abs(item.end - item.start - item.dur) > TOLERANCE) {
        errors.push(`${label}: end does not match start + duration`);
      }
      if (item.shortened) shortened += 1;

      const window = place.windows.find((candidate) => candidate.day === day.day);
      if (!window) {
        errors.push(`${label}: no window that day`);
      } else {
        if (item.start < window.open - TOLERANCE) errors.push(`${label}: starts before opening`);
        if (item.end > window.close + TOLERANCE) errors.push(`${label}: ends after closing`);
      }

      const previous = items[index - 1];
      const previousId = previous?.placeId ?? "START";
      const leg = tau(previousId, item.placeId);
      if (Math.abs(item.travelFromPrevMin - leg) > TOLERANCE) {
        errors.push(`${label}: travel ${item.travelFromPrevMin}, not ${leg}`);
      }
      travel += leg;
      const earliest = (previous ? previous.end : day.dayStart) + leg;
      if (item.start < earliest - TOLERANCE) {
        errors.push(`${label}: starts at ${item.start} before arrival at ${earliest}`);
      }

      const ticket = place.tickets.find((candidate) => candidate.kind === item.ticket.kind);
      if (!ticket) {
        errors.push(`${label}: ticket ${item.ticket.kind} does not exist`);
      } else {
        if (!ticket.eligibleDays.includes(day.day)) {
          errors.push(`${label}: ticket ${item.ticket.kind} not eligible`);
        }
        if (Math.abs(ticket.price - item.ticket.price) > TOLERANCE) {
          errors.push(`${label}: ticket price ${item.ticket.price}, not ${ticket.price}`);
        }
      }
      spend += item.ticket.price;

      // Slack: every visit delayed by its slack at once must still be a feasible day.
      if (item.slack < 0) errors.push(`${label}: negative slack`);
      if (item.slack >= 1440) errors.push(`${label}: slack ${item.slack} spans a day`);
      if (window && item.end + item.slack > window.close + 1e-3) {
        errors.push(`${label}: its slack runs past closing`);
      }
      const next = items[index + 1];
      if (next) {
        const lateArrival = item.end + item.slack + tau(item.placeId, next.placeId);
        if (lateArrival > next.start + next.slack + 1e-3) {
          errors.push(`${label}: its slack overruns ${next.placeId}'s latest start`);
        }
      }
    });

    const last = items.at(-1);
    const dayEnd = schedule.dayEnds.find((candidate) => candidate.day === day.day);
    if (last) {
      const back = tau(last.placeId, "END");
      travel += back;
      const finish = last.end + back;
      if (finish > day.dayEnd + TOLERANCE) errors.push(`day ${day.day}: finishes after the window`);
      if (!dayEnd) errors.push(`day ${day.day}: no dayEnds entry`);
      else {
        if (Math.abs(dayEnd.finish - finish) > TOLERANCE) {
          errors.push(`day ${day.day}: finish ${dayEnd.finish}, not ${finish}`);
        }
        if (finish + last.slack > dayEnd.finish + 1e-3) {
          errors.push(`day ${day.day}: the last visit's slack moves the finish`);
        }
      }
    } else if (dayEnd) {
      errors.push(`day ${day.day}: a dayEnds entry on an unused day`);
    }
  }

  for (const item of schedule.items) {
    if (!dayByNumber.has(item.day)) errors.push(`${item.placeId}: unknown day ${item.day}`);
  }
  if (shortened > instance.Q) errors.push(`${shortened} visits shortened over Q=${instance.Q}`);
  if (instance.budget !== null && spend > instance.budget + TOLERANCE) {
    errors.push(`spend ${spend} over budget ${instance.budget}`);
  }
  if (Math.abs(schedule.totals.spend - spend) > 0.011) {
    errors.push(`totals.spend ${schedule.totals.spend}, items add up to ${spend}`);
  }
  if (Math.abs(schedule.totals.travelMin - travel) > TOLERANCE) {
    errors.push(`totals.travelMin ${schedule.totals.travelMin}, legs add up to ${travel}`);
  }
  if (schedule.totals.covered !== schedule.items.length) {
    errors.push(`totals.covered ${schedule.totals.covered}, ${schedule.items.length} items`);
  }

  for (const dropped of schedule.dropped) {
    if (seen.has(dropped.placeId)) errors.push(`${dropped.placeId}: both visited and dropped`);
  }
  for (const place of instance.places) {
    if (!seen.has(place.id) && !schedule.dropped.some((d) => d.placeId === place.id)) {
      errors.push(`${place.id}: neither visited nor dropped`);
    }
  }
  return errors;
};
