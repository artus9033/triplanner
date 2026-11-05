# Triplanner schedule model (design 02 §4.4, with the fixes listed in the optimizer report).
# Time is one global axis in minutes; day d starts at 1440 * (d - 1).

set P;
set MUST within P;
set DAYS ordered;
set NODES = P union {"START", "END"};
set TICKETS = {"free", "paid", "reduced", "unknown"};

param dur {P} > 0;
param delta {P} >= 0;
param u {P} > 0;
set WIN within {P, DAYS};
param openT {WIN};
param closeT {WIN};
param tau {NODES, NODES} >= 0 default 0;
param dayStart {DAYS};
param dayEnd {DAYS};
param nMax {DAYS} >= 1;
param price {P, TICKETS} >= 0 default 0;
param elig {P, TICKETS, DAYS} binary default 0;
param budget >= 0 default Infinity; # Infinity <=> no limit, and then no constraint is generated
param Q >= 0 default 0;
param lamTau >= 0 default 1;
param lamCost >= 0 default 0;
param lamL1 >= 0 default 0.001;

param M = 1440 * (card(DAYS) + 1);
param PI = 1 + sum {p in P} u[p];
param eps = 1e-4;

# The shortest duration a visit can actually get: only trimmed when shortening is allowed.
param minDur {p in P} = if Q > 0 then dur[p] - delta[p] else dur[p];

# Sparse index sets. Everything impossible stays out of the matrix.
set PD = {(p, d) in WIN: closeT[p, d] - openT[p, d] >= minDur[p]};
set STARTS = {(p, d) in PD:
  max(openT[p, d], dayStart[d] + tau["START", p]) + minDur[p] <= closeT[p, d]
  and max(openT[p, d], dayStart[d] + tau["START", p]) + minDur[p] + tau[p, "END"] <= dayEnd[d]};
set LEGS = {i in P, j in P, d in DAYS: i <> j and (i, d) in PD and (j, d) in PD
  and openT[i, d] + minDur[i] + tau[i, j] + minDur[j] <= closeT[j, d]};
set TK = {p in P, k in TICKETS: exists {d in DAYS: (p, d) in PD} elig[p, k, d] = 1};

var y {PD} binary;
var xStart {STARTS} binary;
var xEnd {STARTS} binary;
var x {LEGS} binary;
var a {DAYS} binary;
var z {TK} binary;
var w {P} binary;
var s {P} >= 0, <= 1440 * card(DAYS);
var F {d in DAYS} >= 0, <= dayEnd[d];

# No defined variables (var v = expr), although the design uses them. With "var Spend = ..." AMPL
# 20260809's presolve reduced "Budget: Spend <= 14" to "0 <= 14" and returned an over-budget solution.
# Mandatory and AtMostOneDay have the same shape, so every sum below is written out.

maximize MaxCoverage: sum {(p, d) in PD} u[p] * y[p, d];
maximize MaxElastic:
  sum {(p, d) in PD} (u[p] + (if p in MUST then PI else 0)) * y[p, d];
# F is in the regularizer so that F*[d] is tight (a loose F* would make pass 3 meaningless).
minimize MinFriction:
  lamTau * (sum {(i, j, d) in LEGS} tau[i, j] * x[i, j, d]
    + sum {(p, d) in STARTS} (tau["START", p] * xStart[p, d] + tau[p, "END"] * xEnd[p, d]))
  + lamCost * sum {(p, k) in TK} price[p, k] * z[p, k]
  + lamL1 * (sum {p in P} s[p] + sum {d in DAYS} F[d]);
param visited {P} binary default 0; # set by trip.run after pass 2
maximize MaxStarts: sum {p in P: visited[p] = 1} s[p];

subject to Mandatory {p in MUST}: sum {(p, d) in PD} y[p, d] = 1;
subject to AtMostOneDay {p in P}: sum {(p, d) in PD} y[p, d] <= 1;

subject to OutDegree {(p, d) in PD}:
  sum {(p, j, d) in LEGS} x[p, j, d] + (if (p, d) in STARTS then xEnd[p, d] else 0) = y[p, d];
subject to InDegree {(p, d) in PD}:
  sum {(i, p, d) in LEGS} x[i, p, d] + (if (p, d) in STARTS then xStart[p, d] else 0) = y[p, d];

subject to DayOpen {d in DAYS}: sum {(p, d) in STARTS} xStart[p, d] = a[d];
subject to DayClose {d in DAYS}: sum {(p, d) in STARTS} xEnd[p, d] = a[d];

subject to WindowLower {p in P}: s[p] >= sum {(p, d) in PD} openT[p, d] * y[p, d];
subject to WindowUpper {p in P}:
  s[p] + dur[p] - delta[p] * w[p] <= sum {(p, d) in PD} closeT[p, d] * y[p, d]
    + M * (1 - sum {(p, d) in PD} y[p, d]);

# The CPM precedence constraint, gated by arc selection. Summing over days is valid (an arc is used
# on at most one day) and dominates the per-day form of §4.3, with |D| times fewer rows.
subject to Propagate {i in P, j in P: i <> j and exists {d in DAYS} (i, j, d) in LEGS}:
  s[j] >= s[i] + dur[i] - delta[i] * w[i] + tau[i, j] - M * (1 - sum {(i, j, d) in LEGS} x[i, j, d]);
# Needs no big-M: at most one xStart[p, d] is 1 and all terms are nonnegative.
subject to FromAnchor {p in P}:
  s[p] >= sum {(p, d) in STARTS} (dayStart[d] + tau["START", p]) * xStart[p, d];
subject to ToAnchor {(p, d) in STARTS}:
  F[d] >= s[p] + dur[p] - delta[p] * w[p] + tau[p, "END"] - M * (1 - xEnd[p, d]);

subject to DailyCap {d in DAYS}: sum {(p, d) in PD} y[p, d] <= nMax[d] * a[d];

subject to OneTicket {p in P}: sum {(p, k) in TK} z[p, k] = sum {(p, d) in PD} y[p, d];
subject to TicketValid {(p, k) in TK}:
  z[p, k] <= sum {(p, d) in PD} elig[p, k, d] * y[p, d];

subject to Budget {if budget < Infinity}: sum {(p, k) in TK} price[p, k] * z[p, k] <= budget;
subject to ShortenBudget: sum {p in P} w[p] <= Q;

param Z1 default 0;
param Fstar {DAYS} default 0;
subject to FixCoverage:
  sum {(p, d) in PD} (u[p] + (if p in MUST then PI else 0)) * y[p, d] >= Z1 - eps;
subject to FixFinish {d in DAYS}: F[d] <= Fstar[d] + 1e-6;
