I'm building a trip-planner web app (React + MUI frontend, Node/TypeScript backend,
MongoDB). By this point the app has already collected, per place the user wants to
visit: coordinates, opening hours for each specific date of the trip, ticket variants
with prices and eligibility conditions, and whether a reservation is needed. The user
has given a date range, a city, and an optional money budget.

Design the optimization step that turns this into one concrete itinerary: which places
to visit, on which day, in what order, starting at what time, with which ticket.

Write it as a design document section I can paste into my spec. I want:

1. A full MILP formulation in AMPL conventions - sets, parameters, decision variables,
   objective, constraints - with the math stated explicitly in LaTeX. Handle multiple
   days, per-date opening-hour time windows, travel times between places, a daily
   activity envelope, a cap on visits per day, ticket choice under the money budget
   (which may be absent), and mandatory vs. optional places. Say how you eliminate
   subtours and how you keep big-M tight.
2. The actual .mod file and the .run driver script, with a concrete solver choice.
3. How the Node backend generates the .dat, invokes AMPL out of process, and parses
   the solution back into typed objects.
4. What to do when it's infeasible or times out - including how to tell the user which
   place caused it, and a heuristic fallback that still produces a feasible schedule.
5. Per-visit slack, so the MUI timeline can show buffers and flag the visits that make
   the day run late.
6. A table of the config constants.

Explain your modelling trade-offs where a different choice was defensible. Keep it
practical - the instances are small (under ~40 places, up to ~2 weeks).
