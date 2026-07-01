# Admin keyset pagination query plans

Measured on PostgreSQL 17.10 with 100,000 rows in each of `memberships`,
`payment_requests`, and `files`. Ten percent of files were quarantined. Tables
were analyzed immediately before each run. Each query requested 51 rows after a
middle-page `(timestamp, id)` boundary. The “before” run dropped only the five
indexes added by migration `0019`; the “after” run recreated them.

| Query | Before | After | Buffers before/after |
| --- | ---: | ---: | ---: |
| memberships | 25.983 ms | 0.060 ms | 1,741 / 5 |
| payment requests (`status = approved`) | 24.768 ms | 0.059 ms | 1,656 / 5 |
| active files | 22.054 ms | 0.068 ms | 1,868 / 5 |
| quarantined files | 11.803 ms | 0.090 ms | 1,852 / 12 |

The tested query shape was:

```sql
SELECT id, created_at
FROM memberships
WHERE (created_at, id) <
  ('2025-01-02 03:46:00+00'::timestamptz,
   'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
ORDER BY created_at DESC, id DESC
LIMIT 51;
```

The payment query additionally filtered by `status`; active and quarantined
file queries used their corresponding partial-index predicate and timestamp.

Representative before/after plans:

```text
-- memberships, before
Limit (actual time=23.044..25.900 rows=51 loops=1)
  Buffers: shared hit=1741
  -> Gather Merge
       -> Sort
            Sort Key: created_at DESC, id DESC
            -> Parallel Seq Scan on memberships
Execution Time: 25.983 ms

-- memberships, after
Limit (actual time=0.023..0.036 rows=51 loops=1)
  Buffers: shared hit=5
  -> Index Only Scan using memberships_created_id_idx on memberships
       Index Cond: (ROW(created_at, id) < ROW(...))
Execution Time: 0.060 ms

-- payment requests, before
Limit (actual time=21.363..24.717 rows=51 loops=1)
  Buffers: shared hit=1656
  -> Gather Merge
       -> Sort
            Sort Key: created_at DESC, id DESC
            -> Parallel Seq Scan on payment_requests
Execution Time: 24.768 ms

-- payment requests, after
Limit (actual time=0.021..0.036 rows=51 loops=1)
  Buffers: shared hit=5
  -> Index Scan using payment_requests_created_id_idx on payment_requests
       Index Cond: (ROW(created_at, id) < ROW(...))
       Filter: (status = 'approved'::text)
Execution Time: 0.059 ms

-- active files, before
Limit (actual time=18.967..21.985 rows=51 loops=1)
  Buffers: shared hit=1868
  -> Gather Merge
       -> Sort
            -> Parallel Seq Scan on files
Execution Time: 22.054 ms

-- active files, after
Limit (actual time=0.033..0.046 rows=51 loops=1)
  Buffers: shared hit=2 read=3
  -> Index Only Scan using files_created_id_active_idx on files
       Index Cond: (ROW(created_at, id) < ROW(...))
Execution Time: 0.068 ms

-- quarantined files, before
Limit (actual time=11.740..11.748 rows=51 loops=1)
  Buffers: shared hit=1852
  -> Sort
       -> Seq Scan on files
Execution Time: 11.803 ms

-- quarantined files, after
Limit (actual time=0.047..0.066 rows=51 loops=1)
  Buffers: shared hit=10 read=2
  -> Index Only Scan using files_quarantined_id_idx on files
       Index Cond: (ROW(quarantined_at, id) < ROW(...))
Execution Time: 0.090 ms
```
