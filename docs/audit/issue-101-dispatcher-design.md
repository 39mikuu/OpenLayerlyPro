# Issue #101 — task claim paths, leases, and bounded dispatcher concurrency

- **Baseline:** `e08363ab988785cc510ea1900f7e2c178bf14cf8` (validated on the current `main`).
- **Type:** design + benchmark. **No production code is changed in this branch.**
- **Classification result:** **Confirmed P2 scalability issue; not a v1.0 correctness blocker.** The
  two low-risk query-path optimizations in §4 may be tracked and landed independently, while batch
  execution (§4.1) remains a separate guarded design task. The correctness/fencing invariants (§1)
  are intact.
- **Artifacts:** `src/modules/tasks/dispatcher-benchmark.integration.test.ts` (gated behind
  `RUN_TASK_BENCHMARK=true`) and this document.

## 1. Invariants — already locked down

These invariants are already covered by existing PostgreSQL integration tests in
`src/modules/tasks/index.integration.test.ts` (verified passing on this branch):

| Invariant | Evidence |
| --- | --- |
| Final-attempt expired lease becomes `dead` (attempt not re-created over the limit) | "counts lease recovery as a new execution and does not exceed max attempts"; "logs lease-expiry dead letters for mail tasks after the sweep commits"; "enters dead on attempt five" |
| Stale worker cannot overwrite a newer worker (fencing on `lockedBy` + `status`) | "fences stale success and failure updates after another worker reclaims the task"; "renews a lease only for the current claim token"; "defers precisely with fencing" |
| `FOR UPDATE SKIP LOCKED` — two workers never claim the same row | "does not let concurrent workers claim the same task" |
| External I/O stays outside DB transactions | `dispatchClaimedTask` runs `dependencies.run(task)` outside any tx; only claim/finalize open transactions (`index.ts`, `dispatcher.ts`) |
| Dedupe on `dedupeKey` | `tasks_dedupe_key_unique` + `enqueueTask` `onConflictDoNothing`; "deduplicates non-null keys while allowing tasks without keys" |
| Production uses PostgreSQL clock for due/lease/backoff | "uses PostgreSQL time for production claim, lease, and failure backoff" |
| Concurrency is bounded | `dispatchTaskBatch` processes at most `TASK_BATCH_SIZE` (20) sequentially per tick; `startTaskDispatcher` guards re-entrancy with a `running` flag |

**Conclusion:** the correctness invariants hold today. The findings below are **performance and
scalability**, not correctness defects. No fencing/lease/transaction-boundary change is required for
correctness; the recommended changes are optimizations that must preserve all of the above.

## 2. Benchmark — 100,000 mixed-state tasks (real PostgreSQL 16)

Seed mix: 30k pending-due, 20k pending-future, 15k failed-due, 10k processing fresh-lease, 5k
processing stale-lease (retryable), 2k processing stale-lease final-attempt (sweep targets), 15k
succeeded, 3k dead.

| Measurement | Result |
| --- | --- |
| `claimDueTasks(1)` sequential ×200 | p50 **22.1 ms**, p95 **25.1 ms**, ~**44 claims/s** (single worker) |
| `claimDueTasks(20)` ×50 | p50 **23.5 ms**, p95 **25.7 ms** (≈ same as claim(1)) |
| 4× concurrent `claimDueTasks(20)` | 2000 claims in **817 ms** = ~**2449 claims/s**, even split 500/500/500/500 |
| Idle `claimDueTasks(1)` (nothing due) | p50 **22.7 ms** — the fixed cost is paid even with zero claimable work |

## 3. Query-plan analysis

### 3.1 Current claim SELECT (`index.ts` `claimDueTasksInternal`)

```
WHERE attempts < max_attempts
  AND ( (status IN ('pending','failed') AND run_after <= now())
     OR (status = 'processing' AND lease_until < now()) )
ORDER BY run_after LIMIT n FOR UPDATE SKIP LOCKED
```

`EXPLAIN (ANALYZE, BUFFERS)` at 100k rows:

```
Limit  (actual time=25.875..25.890 rows=20)
  -> LockRows
    -> Sort  (Sort Key: run_after; quicksort 3964kB)
      -> Seq Scan on tasks (rows=50000 removed by filter, shared hit=1400)
Execution Time: 26.575 ms
```

The `tasks_claim_idx (status, run_after)` index is **unusable**: the `OR` spans two branches keyed
on different columns (`run_after` vs `lease_until`), so the planner **seq-scans all 100k rows and
sorts the 17k matches** on every call. Cost is **O(total rows)** — it grows with terminal
`succeeded`/`dead` and future `pending` rows that can never be claimed.

### 3.2 Per-transaction final-attempt sweep

The sweep `UPDATE ... WHERE status='processing' AND lease_until < now() AND attempts >= max_attempts`
runs **inside every claim transaction** (i.e. up to 20× per tick via `claim(1)`):

```
Update on tasks (Bitmap Heap Scan; Bitmap Index Scan on tasks_claim_idx, status='processing' rows=17000)
Execution Time: 17.500 ms
```

It scans all 17k `processing` rows via the index to touch the 2k final-attempt rows, repeated per
claim.

### 3.3 Proposed indexes + split query (design only — measured on the test DB, not migrated)

Adding partial indexes and splitting the OR into two index-friendly probes:

```sql
CREATE INDEX tasks_claimable_idx  ON tasks (run_after)  WHERE status IN ('pending','failed');
CREATE INDEX tasks_stale_lease_idx ON tasks (lease_until) WHERE status = 'processing';
```

| Branch | Plan | Execution |
| --- | --- | --- |
| pending/failed due (`tasks_claimable_idx`) | Index Scan, LockRows, Limit 20 | **0.100 ms** |
| stale-processing (`tasks_stale_lease_idx` / existing) | Index Scan, LockRows, Limit 20 | **0.091 ms** |

**~260× faster**, and bounded by `LIMIT` rather than total table size.

## 4. Design recommendations (NOT implemented — awaiting human approval)

Preserving every invariant in §1:

1. **Make the claim SELECT index-usable.** Replace the single OR query with two bounded index probes
   (pending/failed-due, then stale-processing) merged to `LIMIT n`, backed by the partial indexes
   in §3.3. Keeps `ORDER BY run_after`, `FOR UPDATE SKIP LOCKED`, and the `attempts < max_attempts`
   guard. Turns claim cost from O(total) into O(due).
2. **Sweep once per tick, not per claim.** Run the final-attempt sweep a single time at the start of
   `dispatchTaskBatch` (or fold it into the batch claim transaction), not inside every `claim(1)`.
   The `attempts >= max_attempts` → `dead` semantics and the mail dead-letter WARN must be preserved.
These two items **preserve the current claim-one / execute-one lease timing** — each task is still
leased immediately before its own execution — so they carry no lease-before-start risk.

> **Not in this package: batching the claim SELECT.** Although `claim(20)` costs the same as
> `claim(1)` (§2), batch claiming is the point at which lease-before-start behavior begins: even with
> sequential execution, every task in a batch starts its lease at batch-claim time, so a task later
> in the batch can approach expiry before it is executed. Batch claim therefore belongs to the
> separate guarded execution-model follow-up in §4.1, not to the low-risk query-path package above.

### 4.1 Sequential claim-one vs small-batch bounded concurrency

| Dimension | Current: `claim(1)` × N sequential | Proposed: `claim(min(N, cap))` batch, bounded parallel execution |
| --- | --- | --- |
| Claim SQL per tick | up to 20 selects + 20 sweeps (~40 × ~20 ms) | 1 sweep + 1 batch select (~2 queries) |
| Claim overhead @100k | ~800 ms/tick (query-bound, ~44 claims/s) | ~25 ms/tick for the same 20 (with §1 indexes, sub-ms) |
| Lease-before-start risk | none (each task leased immediately before its own execution) | **must guard**: a batch-claimed task's lease starts at claim time; if execution is still sequential, the last task in a large batch can expire before it starts. Mitigation: cap batch to what a worker can process within one lease, and/or renew on dequeue, and/or execute with bounded parallelism (worker pool). |
| Idempotency / fencing | unchanged | unchanged — completion still fenced on `lockedBy` + `status`; external side effects remain idempotent via `dedupeKey` |
| DB connections | 1 per claim/finalize (pool max 10) | batch reduces claim-transaction count; parallel execution needs a bounded worker pool ≤ pool size |

**Recommendation — two explicitly separate follow-ups:**

- **Low-risk query-path follow-up:** split the pending/failed and stale-processing probes; add the
  matching partial indexes; run the final-attempt sweep once per tick; **preserve the current
  claim-one / execute-one lease timing.** Removes the O(total) scaling cliff with no lease-timing
  change.
- **Separate guarded execution-model follow-up:** batch claim; bounded parallelism; dequeue-time
  lease renewal (or equivalent lease protection); dedicated lease-expiry / concurrency tests. This
  is where lease-before-start begins, so it must not be bundled with the query-path package.

## 5. v1.0 impact

**Not release-blocking for correctness.** The invariants hold. At small task volumes the current
~22 ms/claim is immaterial. It becomes a throughput/latency problem only as the `tasks` table grows
(especially with retained terminal rows). Recommendation: land the **low-risk query-path follow-up**
as one narrowly-scoped performance issue post-HOLD (or before v1.0 if task volume is expected to be
high), behind its own reviewed Draft PR with the existing invariant tests as regression guards; track
the **guarded execution-model follow-up** (batch claim + bounded parallelism + lease handling)
separately with its own lease-expiry/concurrency test matrix. Await human approval before any
implementation PR.
