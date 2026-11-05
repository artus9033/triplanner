4. Trip schedule optimization (AMPL)

4.0 Problem statement

After step 2 the database holds, for every candidate place, structured opening hours restricted to the user's travel dates, ticket variants with prices, and a geocoded location. Step 4 turns that into one concrete, feasible, time-stamped itinerary: which places are visited, on which day, in which order, starting at what minute, with which ticket bought — maximizing the value of the trip subject to opening hours, the daily time envelope, travel times and the (optional) money budget.

Formally this is a multi-day Team Orienteering Problem with Time Windows (TOPTW) — the tourist-trip-design variant of the vehicle routing problem — where each day plays the role of one vehicle/machine. It is NP-hard in general, but the instances here are small (|P| ≤ 5 bots × a handful of places each, i.e. ~10–40 nodes, |D| ≤ ~14), so a MILP solved by branch-and-bound is the right tool, with a time limit and a heuristic fallback (§4.8).

Two structural ideas are lifted directly from the earlier projects:

- The time-propagation constraint is the CPM precedence constraint start[i] + times[i] <= start[j] of Projekt 1, gated by a big-M on the arc-selection variable. Because time strictly increases along every selected arc, this constraint doubles as subtour elimination (an MTZ-style formulation), so no separate subtour cuts are needed.
- The slack shown in the UI is computed by the Projekt 1 Zadanie 3 trick: fix the optimum, then re-solve maximizing the sum of start times to obtain latest admissible starts; latest − earliest is the total slack per visit.

  4.1 Notation

Sets

- $P$ — candidate places accepted by the user in step 1 and enriched in step 2.
- $P^{\text{must}} \subseteq P$ — places the user named explicitly (e.g. "the Louvre, Richelieu wing"); these are mandatory.
- $P^{\text{opt}} = P \setminus P^{\text{must}}$ — places proposed by search/LLM; visiting them is optional and rewarded.
- $D$ — ordered set of trip days, $d = 1, \dots, |D|$, derived from the date range collected by the state machine.
- $V = P \cup {\texttt{START}, \texttt{END}}$ — working node set, with two artificial nodes representing leaving and returning to the accommodation (or the city-centre anchor if no hotel is known). Their visit duration is $0$. This is exactly the role of the artificial tasks $\texttt{P}, \texttt{K}$ in Projekt 1.
- $A = {(i,j) \in V \times V : i \neq j,\ j \neq \texttt{START},\ i \neq \texttt{END}}$ — admissible arcs.
- $K_p$ — ticket variants of place $p$ (free / paid / reduced) from the scraped tickets array.

Parameters

Time is a single global axis in minutes, $t = 0$ at 00:00 of the first trip day; day $d$ therefore starts at $1440(d-1)$. This keeps one start-time variable per place and lets day assignment be inferred from absolute windows.

- $\mathrm{dur}_p > 0$ — nominal visit duration of $p$ (minutes). Taken from a per-category table of defaults in the config (museum 120, gallery 60, restaurant 90, viewpoint 30, …), overridable by the LLM's own estimate.
- $\mathrm{dur}^{\min}_p$, $\delta_p$ — shortest acceptable duration and the single admissible reduction step, $\mathrm{dur}^{\min}_p \le \mathrm{dur}_p - \delta_p$ (used by §4.6).
- $[\underline{o}{p,d}, \overline{c}{p,d}]$ — effective window of $p$ on day $d$, in absolute minutes:
  $$\underline{o}{p,d} = \max(\text{open}{p,d},, H^-d), \qquad \overline{c}{p,d} = \min(\text{close}{p,d},, H^+d)$$
  where $\text{open}{p,d}, \text{close}{p,d}$ come from the scraped hours[] entry whose date equals day $d$, and $[H^-_d, H^+_d]$ is the user's daily activity envelope (config default 09:00–20:00, per-day overridable). Clamping the opening hours to the daily envelope means the envelope needs no separate constraint.
- $\mathrm{avail}{p,d} \in {0,1}$ — $1$ iff $\overline{c}{p,d} - \underline{o}_{p,d} \ge \mathrm{dur}^{\min}p$, i.e. the place is open long enough on day $d$. A missing hours entry for a date means closed, $\mathrm{avail}{p,d} = 0$ (a deliberately conservative reading of scraped data).
- $\tau_{i,j} \ge 0$ — travel time from $i$ to $j$ (minutes), for the trip's transport mode (config: walking | transit | driving). Source: one routing-matrix call over $|V|^2$ pairs; fallback $\tau_{i,j} = \text{haversine}(i,j) / v_{\text{mode}}$ with the mode speeds in the config. Note $\tau$ need not be symmetric.
- $\mathrm{price}_{p,\kappa} \ge 0$ — price of ticket variant $\kappa \in K_p$, normalized into the user's currency (free variants: $0$).
- $\mathrm{elig}_{p,\kappa,d} \in {0,1}$ — whether variant $\kappa$ is applicable on day $d$ (this is where the scraped condition text is resolved, e.g. "on Tuesday it is free" or "under 25 reduced", against the user's profile and the weekday of $d$).
- $B$ — money budget. If the user declared no limit (null in the trip state), the budget constraint is not generated at all rather than set to a large number — this avoids a needless big coefficient in the matrix.
- $u_p > 0$ — utility weight of visiting $p$. Config scheme: $u_p = 100$ for $p \in P^{\text{must}}$, $u_p = 10 \cdot \mathrm{rank}^{-1}$ for suggested places, scaled by the user's multiselect ordering in step 1.
- $N^{\max}_d$ — maximum number of visits per day (config default 4, anti-exhaustion).
- $Q$ — "impatience budget": how many visits may be shortened (§4.6), config default 0 (feature off).
- $M$ — big-M constant, $M = 1440(|D| + 1)$ — the smallest value that dominates the time axis, kept tight on purpose (the lot-sizing model in Projekt 2 §3 shows the same $w \le M v$ pattern; here a loose $M$ would visibly weaken the LP relaxation).

Decision variables

- $y_{p,d} \in {0,1}$ — place $p$ is visited on day $d$.
- $\mathrm{vis}p = \sum{d \in D} y_{p,d} \in {0,1}$ — $p$ is visited at all (defined variable, not a new integer).
- $x_{i,j,d} \in {0,1}$ — on day $d$, the itinerary goes directly from $i$ to $j$. (Assignment-with-position logic, as in Projekt 2 §2.2, but here position is replaced by an explicit arc so that travel time enters the objective.)
- $s_p \ge 0$ — absolute start minute of the visit at $p$. The analogue of start[n].
- $F_d \ge 0$ — minute at which day $d$'s itinerary ends (back at the anchor). The per-day analogue of $s_\texttt{K}$.
- $a_d \in {0,1}$ — day $d$ is used at all (allows rest days to fall out naturally).
- $z_{p,\kappa} \in {0,1}$ — ticket variant $\kappa$ is bought for $p$.
- $w_p \in {0,1}$ — the visit at $p$ is shortened by $\delta_p$ (§4.6).

Effective duration: $\widehat{\mathrm{dur}}_p = \mathrm{dur}_p - \delta_p w_p$ — linear, since $\delta_p$ is a constant.

4.2 Objective

The criteria (see as many good places as possible / travel as little as possible / spend as little as possible) are not commensurable, so they are resolved lexicographically in three solver passes, which is both more honest than hand-tuned weights and reuses the fix-then-re-optimize pattern of Projekt 1 Zadanie 3.

Pass 1 — coverage. Maximize the utility of the itinerary:
$$Z_1^\star = \max \sum_{p \in P} u_p ,\mathrm{vis}_p$$

Pass 2 — compactness. Fix $\sum_p u_p \mathrm{vis}p = Z_1^\star$ and minimize friction:
$$Z_2^\star = \min\ \lambda\tau \sum_{(i,j) \in A} \sum_{d \in D} \tau_{i,j} x_{i,j,d} ;+; \lambda_$ \sum_{p \in P} \sum_{\kappa \in K_p} \mathrm{price}{p,\kappa} z{p,\kappa} ;+; \lambda_{L1} \sum_{p \in P} s_p$$

The last term is the $L_1$ regularizer of Projekt 1, with $\lambda_{L1} = 10^{-3}$ relative to the other scaled terms. As before, the absolute value is dropped because $s_p \ge 0$. It serves the same two purposes: it makes the optimum unique (otherwise whole families of schedules tie), and it pulls every visit as early as its window allows, so pass 2 directly yields the earliest-start schedule. $\lambda_\tau, \lambda_$$ are config constants; $\lambda_$$ is set from the user's budget scale ($B / |P|$) so that money and minutes are comparable, or to $0$ when $B$ is null.

Pass 3 — slack. Fix both $Z_1^\star$ and the travel/cost part of $Z_2^\star$, then
$$\max \sum_{p \in P} s_p \quad\text{s.t.}\quad F_d \le F_d^\star \ \ \forall d \in D$$
giving the latest admissible starts. The per-visit total slack
$$\mathrm{slack}_p = s_p^{\text{late}} - s_p^{\text{early}}$$
is what the UI renders as the grey buffer on the timeline (§4.9), and $\mathrm{slack}_p = 0$ identifies the critical visits — the ones that cannot be delayed without pushing the rest of the day — which is the trip-planning counterpart of the critical path.

4.3 Constraints

1. Mandatory places. $\mathrm{vis}_p = 1 \quad \forall p \in P^{\text{must}}$.
2. At most one visit, on one day. $\sum_{d \in D} y_{p,d} \le 1 \quad \forall p \in P$.
3. Day availability. $y_{p,d} \le \mathrm{avail}{p,d} \quad \forall p \in P, d \in D$. (Pre-solve: places with $\sum_d \mathrm{avail}{p,d} = 0$ are removed from $P$ and reported to the user as "closed during your dates" — closing them out in data rather than in the model keeps the MILP small and the explanation precise.)
4. Degree / flow. Each visited place is entered once and left once on its day:
   $$\sum_{j:(p,j)\in A} x_{p,j,d} = y_{p,d}, \qquad \sum_{i:(i,p)\in A} x_{i,p,d} = y_{p,d} \quad \forall p \in P, d \in D$$
5. Day opening/closing. $\sum_{j} x_{\texttt{START},j,d} = a_d$, $\sum_{i} x_{i,\texttt{END},d} = a_d$, and $a_d \ge y_{p,d}\ \forall p$ — so a day with no visits uses no arcs.
6. Time windows.
   $$s_p \ \ge\ \sum_{d \in D} \underline{o}{p,d}, y{p,d}, \qquad s_p + \widehat{\mathrm{dur}}p \ \le\ \sum{d \in D} \overline{c}{p,d}, y{p,d} + M(1 - \mathrm{vis}p)$$
   Because the windows are absolute on the global axis, these two inequalities simultaneously enforce the opening hours, the daily envelope, and consistency between $s_p$ and the day chosen by $y{p,\cdot}$. The big-M release on the upper bound is needed so that an unvisited place does not force $s_p + \mathrm{dur}_p \le 0$.
7. Time propagation along the itinerary — the Projekt 1 precedence constraint, arc-gated:
   $$s_j \ \ge\ s_i + \widehat{\mathrm{dur}}i + \tau{i,j} - M,(1 - x_{i,j,d}) \quad \forall (i,j) \in A,\ i,j \in P,\ d \in D$$
   Compare start[i] + times[i] <= start[j]: identical, with travel time added and the relation now chosen rather than given. Since $\widehat{\mathrm{dur}}i + \tau{i,j} > 0$ on every arc, time strictly increases along any selected path, so no cycle among the $P$-nodes can be selected — this is the subtour elimination.
8. Depot arcs.
   $$s_j \ \ge\ H^-d + \tau{\texttt{START},j} - M(1 - x_{\texttt{START},j,d}), \qquad F_d \ \ge\ s_i + \widehat{\mathrm{dur}}i + \tau{i,\texttt{END}} - M(1 - x_{i,\texttt{END},d})$$
   with $F_d \le H^+_d$.
9. Daily load cap. $\sum_{p \in P} y_{p,d} \le N^{\max}_d \quad \forall d \in D$.
10. Ticket choice. $\sum_{\kappa \in K_p} z_{p,\kappa} = \mathrm{vis}p$ and $z{p,\kappa} \le \sum_{d} \mathrm{elig}{p,\kappa,d}, y{p,d}$ — exactly one ticket per visited place, and only a variant valid on the chosen day.
11. Money budget (generated only when $B \neq \texttt{null}$): $\sum_{p \in P} \sum_{\kappa \in K_p} \mathrm{price}{p,\kappa} z{p,\kappa} \le B$.
12. Shortening budget (§4.6): $\sum_{p \in P} w_p \le Q$, with $w_p = 0$ forced whenever $\mathrm{dur}_p - \delta_p < \mathrm{dur}^{\min}_p$.

Note the deliberate asymmetry with Projekt 1: there, all tasks had to be scheduled and the question was when; here, optional places may be dropped ($\mathrm{vis}_p = 0$). That is what keeps the model feasible almost always, and it is why coverage is maximized in the objective instead of being a constraint. The only genuine infeasibility source is $P^{\text{must}}$ (§4.7).

4.4 AMPL model (trip.mod)

ampl

# ---------- sets ----------

set P; # places
set MUST within P;
set DAYS ordered;
set NODES = P union {"START", "END"};
set ARCS = {i in NODES, j in NODES: i <> j and j <> "START" and i <> "END"};
set TICKETS; # "free" | "paid" | "reduced"

# ---------- parameters ----------

param dur {P} > 0;
param durMin {P} >= 0;
param delta {P} >= 0 default 0;
param avail {P, DAYS} binary;
param openT {P, DAYS}; # absolute minutes, clamped to the day envelope
param closeT {P, DAYS};
param tau {NODES, NODES} >= 0 default 0;
param dayStart {DAYS};
param dayEnd {DAYS};
param price {P, TICKETS} >= 0 default 0;
param elig {P, TICKETS, DAYS} binary default 0;
param u {P} > 0;
param nMax {DAYS} >= 1;
param budget >= 0 default Infinity; # Infinity <=> user declared no limit
param Q >= 0 default 0;
param M = 1440 \* (card(DAYS) + 1);
param lamTau >= 0 default 1;
param lamCost >= 0 default 0;
param lamL1 >= 0 default 0.001;

# ---------- variables ----------

var y {P, DAYS} binary;
var x {ARCS, DAYS} binary;
var s {P} >= 0;
var F {DAYS} >= 0;
var a {DAYS} binary;
var z {P, TICKETS} binary;
var w {P} binary;

var vis {p in P} = sum {d in DAYS} y[p,d];
var effDur {p in P} = dur[p] - delta[p] \* w[p];

var Coverage = sum {p in P} u[p] _ vis[p];
var Travel = sum {(i,j) in ARCS, d in DAYS} tau[i,j] _ x[i,j,d];
var Spend = sum {p in P, k in TICKETS} price[p,k] \* z[p,k];
var L1 = sum {p in P} s[p];

# ---------- objectives (selected per pass) ----------

maximize MaxCoverage: Coverage;
minimize MinFriction: lamTau _ Travel + lamCost _ Spend + lamL1 \* L1;
maximize MaxStarts: L1;

# ---------- constraints ----------

subject to Mandatory {p in MUST}: vis[p] = 1;
subject to AtMostOneDay {p in P}: sum {d in DAYS} y[p,d] <= 1;
subject to Availability {p in P, d in DAYS}: y[p,d] <= avail[p,d];

subject to OutDegree {p in P, d in DAYS}:
sum {(i,j) in ARCS: i = p} x[i,j,d] = y[p,d];
subject to InDegree {p in P, d in DAYS}:
sum {(i,j) in ARCS: j = p} x[i,j,d] = y[p,d];

subject to DayOpen {d in DAYS}:
sum {(i,j) in ARCS: i = "START"} x[i,j,d] = a[d];
subject to DayClose {d in DAYS}:
sum {(i,j) in ARCS: j = "END"} x[i,j,d] = a[d];
subject to DayUsed {p in P, d in DAYS}: a[d] >= y[p,d];

subject to WindowLower {p in P}:
s[p] >= sum {d in DAYS} openT[p,d] _ y[p,d];
subject to WindowUpper {p in P}:
s[p] + effDur[p] <= sum {d in DAYS} closeT[p,d] _ y[p,d] + M \* (1 - vis[p]);

# the CPM precedence constraint of Projekt 1, gated by arc selection

subject to Propagate {(i,j) in ARCS, d in DAYS: i in P and j in P}:
s[j] >= s[i] + effDur[i] + tau[i,j] - M \* (1 - x[i,j,d]);

subject to FromAnchor {(i,j) in ARCS, d in DAYS: i = "START" and j in P}:
s[j] >= dayStart[d] + tau[i,j] - M _ (1 - x[i,j,d]);
subject to ToAnchor {(i,j) in ARCS, d in DAYS: i in P and j = "END"}:
F[d] >= s[i] + effDur[i] + tau[i,j] - M _ (1 - x[i,j,d]);
subject to DayEnvelope {d in DAYS}: F[d] <= dayEnd[d];

subject to DailyCap {d in DAYS}: sum {p in P} y[p,d] <= nMax[d];

subject to OneTicket {p in P}: sum {k in TICKETS} z[p,k] = vis[p];
subject to TicketValid {p in P, k in TICKETS}:
z[p,k] <= sum {d in DAYS} elig[p,k,d] \* y[p,d];

subject to Budget: Spend <= budget;
subject to ShortenBudget: sum {p in P} w[p] <= Q;
subject to ShortenFloor {p in P: dur[p] - delta[p] < durMin[p]}: w[p] = 0;

Driver script (trip.run), three passes

ampl
option solver highs;
option highs_options "timelim=10 mipgap=1e-4";

# pass 1 - coverage

objective MaxCoverage; solve;
param Z1 := Coverage;

# pass 2 - compactness -> earliest starts

subject to FixCoverage: Coverage = Z1;
objective MinFriction; solve;
param travelStar := Travel; param spendStar := Spend;
param Fstar {d in DAYS} := F[d];
param sEarly {p in P} := s[p];

# pass 3 - latest starts -> slack

subject to FixTravel: Travel = travelStar;
subject to FixSpend: Spend = spendStar;
subject to FixFinish {d in DAYS}: F[d] <= Fstar[d];
objective MaxStarts; solve;

printf "{\"coverage\":%g,\"travel\":%g,\"spend\":%g,\"items\":[", Z1, travelStar, spendStar > out.json;
printf {p in P, d in DAYS: y[p,d] > 0.5}
"{\"place\":\"%s\",\"day\":%d,\"start\":%d,\"dur\":%d,\"slack\":%d,\"ticket\":\"%s\"},",
p, d, sEarly[p], dur[p] - delta[p]\*w[p], s[p] - sEarly[p],
(if exists {k in TICKETS} z[p,k] > 0.5 then
first({k in TICKETS: z[p,k] > 0.5}) else "none") > out.json;
printf "]}" > out.json;

(The trailing-comma JSON is cleaned up by the parser; emitting a line-oriented CSV and building the JSON in Node is the less clever and probably better choice.)

4.5 Backend integration

- Module. backend/src/optimizer/ with buildInstance.ts (Mongo documents → a typed TripInstance), writeData.ts (TripInstance → trip.dat), runSolver.ts (child process), parseSolution.ts (solver output → TripSchedule), fallback.ts (§4.8). All instance and solution shapes are zod schemas shared with the frontend, so the timeline consumes the same types the solver produces.
- Invocation. The backend is Node, so AMPL runs out of process: spawn("ampl", ["trip.run"], { cwd: runDir }) in a per-run temp directory, with HiGHS (MILP, free) as solver and CBC as an alternative. ampl and the solver binaries are pinned in the dev docker-compose.yml alongside MongoDB, so pnpm dev needs no local AMPL install. trip.mod is a static asset; only trip.dat is generated per run.
- Deterministic runs. trip.dat is written with sorted keys and fixed numeric formatting, and hashed; the hash keys a cache of solutions, so re-opening a trip does not re-solve.
- Lifecycle. The run is a job on the trip document (optimization: { status, startedAt, instanceHash, result, diagnostics }), with status ∈ { pending, running, solved, infeasible, fallback, failed }. Status is streamed to the UI over the same channel the step-2 bots report on, so step 3's "in the meantime" is literal: scraping and solving are concurrent, and the timeline step turns from pending to ready when solved arrives.
- Timeouts. Solver wall-clock limit OPTIMIZER_TIME_LIMIT_MS (config, default 10 000). On timeout, HiGHS's best incumbent is used if one exists (it is feasible, just not proven optimal — report it as "good schedule" rather than "optimal"); otherwise the fallback heuristic runs.

  4.6 Optional extension — shortening visits (the crashing analogue)

Projekt 1 Zadanie 4 shortens tasks by spending a budget; the same mechanism applies here with "user patience" as the budget: $w_p = 1$ trims the visit at $p$ by $\delta_p$ (config: 25% of $\mathrm{dur}_p$, never below $\mathrm{dur}^{\min}_p$), at most $Q$ times across the trip. It is worth switching on exactly when pass 1 cannot fit a mandatory place: trimming two long museum visits can admit a third place, and — as in Projekt 1, where shortening $G$ off the critical path bought nothing — only trims on the day's binding chain actually change the outcome. Default $Q = 0$; the UI offers it as "fit more in" after an infeasible or low-coverage first solve.

4.7 Infeasibility and diagnosis

An honest answer beats an empty timeline. If pass 1 is infeasible, the cause is always in $P^{\text{must}}$ (optional places can be dropped), so the backend re-solves with constraint 1 relaxed into a penalized form,
$$\max \sum_{p} u_p \mathrm{vis}p - \Pi \sum{p \in P^{\text{must}}} (1 - \mathrm{vis}_p), \qquad \Pi \gg \max_p u_p,$$
which is an elastic/IIS-style relaxation: the mandatory places that still come out unvisited are precisely the ones that cannot be accommodated. Each is reported with its binding reason, read off the instance rather than guessed — closed on all trip dates, open only outside the daily envelope, ticket price alone exceeding $B$, or unreachable within the day given $\tau$. The user then gets a concrete choice in the chat: widen the daily envelope, extend the dates, drop the place, or allow shortening (§4.6). The same loop handles a budget that is simply too small, since then the only feasible tickets are the free ones.

4.8 Fallback heuristic

If AMPL is unavailable or times out with no incumbent, a greedy insertion heuristic produces a feasible schedule — the same role LPT played in Projekt 2 §1.2b: no optimality guarantee, cheap, and good enough to display.

1. Sort $P$ by $u_p$ descending, mandatory places first (the Projekt 2 "longest/most important first" ordering).
2. For each place in order, try every (day, insertion position) pair; compute the feasible start from the predecessor's finish plus travel, clipped to $[\underline{o}{p,d}, \overline{c}{p,d}]$; reject any insertion that violates a window, $F_d \le H^+_d$, $N^{\max}_d$ or the budget.
3. Accept the feasible insertion minimizing added travel time (ties broken by earliest start).
4. Then run the Projekt 2 §1.2c local improvement: move the last visit of the most overloaded day to a better day, and try pairwise swaps between days; keep a move only if it strictly improves total travel without breaking a window. Stop after FALLBACK_MAX_PASSES (config, default 2) non-improving passes.

Slack is computed for the heuristic solution too, by a backward pass over each day's fixed sequence ($s^{\text{late}}p = \min(\overline{c}{p,d} - \mathrm{dur}p,\ s^{\text{late}}{\text{next}} - \tau - \mathrm{dur}_p)$) — the CPM backward recursion, so the UI contract is identical whichever path produced the schedule.

4.9 What the UI receives

The solution maps onto the planned views without further computation:

- Final MUI Timeline — one TimelineItem per scheduled visit, grouped by day with date separators, each showing start–end, the chosen ticket variant and price, a travel connector carrying $\tau$ and the mode on the TimelineConnector between consecutive items, and a reservation badge where needs_reservation is true. Hovering an item highlights the corresponding map pin and opens its popup, as specified.
- Slack — rendered as a lighter trailing band on each item, width $\propto \mathrm{slack}_p$, tooltip "can start up to N min later". Items with $\mathrm{slack}_p = 0$ get a "tight" marker: these are the visits that make the day run late if missed, which is the user-facing form of the critical path.
- Dropped places — a collapsed "not included" list with the reason from §4.7, each offering "try to fit this in" (re-solve with $p$ forced into $P^{\text{must}}$ and $Q > 0$).
- Totals — $\sum$ travel time, $\sum$ ticket spend against $B$, places covered out of $|P|$, shown as a summary header above the timeline.
- Explainability — the diagnostics block keeps the objective values of all three passes, the solver status, the MIP gap and the wall time, surfaced in a dev-only panel. It is what makes a surprising schedule debuggable rather than mysterious.

  4.10 Configuration constants (backend/src/config/optimizer.ts)

┌────────────────────────────┬──────────────────────┬───────────────────────────────────────────────────┐
│ Constant │ Default │ Meaning │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ MAX*BOTS │ 5 │ step-2 scraping concurrency (already in the plan) │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ BOT_TIME_BUDGET_MS │ 60 000 │ per-bot cap stated in the prompt │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ DAY_WINDOW │ 09:00–20:00 │ $[H^-_d, H^+_d]$ │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ MAX_VISITS_PER_DAY │ 4 │ $N^{\max}_d$ │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ DEFAULT_DURATIONS │ per category │ $\mathrm{dur}_p$ table │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ TRANSPORT_MODE │ walking │ $\tau$ source mode │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ MODE_SPEEDS │ 4.5 / 18 / 30 km·h⁻¹ │ haversine fallback for $\tau$ │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ LAMBDA_TRAVEL, LAMBDA_COST │ 1, derived │ $\lambda*\tau, \lambda\_$$ │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ LAMBDA_L1 │ 0.001 │ $L_1$ regularizer, as in Projekt 1 │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ SHORTEN_BUDGET │ 0 │ $Q$ │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ OPTIMIZER_TIME_LIMIT_MS │ 10 000 │ solver wall clock │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ SOLVER │ highs │ highs | cbc │
├────────────────────────────┼──────────────────────┼───────────────────────────────────────────────────┤
│ FALLBACK_MAX_PASSES │ 2 │ local-improvement passes │
└────────────────────────────┴──────────────────────┴───────────────────────────────────────────────────┘
