# 32 — 128 rows per cell is right, float64 is right, and the container was wrong

**What to decide:** forecaster 30 froze `B(s, h)` into the bundle, measured what
it cost, and deliberately did not decide whether the cost was acceptable. Two
questions were left open: is **128 rows per cell** the right number, and is a
**raw float64 matrix** the right representation?

**The answer, in one line:** the sample is correct as drawn and the *file* was
not. 128 rows per cell stays, float64 stays, every column stays, and the bundle
is now written through `zlib` — which is lossless, changes no value the
attribution reads, and takes a real 128-row artifact from **11,224,847 bytes to
2,217,719** for **+7.8 ms** on a load that happens four times a day.

Everything below is measured. Where a figure is arithmetic over measurements it
says so.

## What was measured, and against what

Forecaster 30's numbers came off the fixture fold, because on 2026-09-09 the
database held no ingested rows. It does now — data-platform's backfill landed
892 days of ONS curtailment and load — so the sizing question was re-measured
against **real rows**: `feature_rows(2026-01-01, 2026-06-30, 'gate_late',
'dessem_free_v1', 5.0)` on `fc18-pg`, read-only, 17,376 rows, `k = 100`,
`feature_hash sha256:f755511b…`, 181 rows in every one of the 96 cells. A real
`B(s, h)` at the spec's 128 was drawn from it and the fixture numbers are kept
beside it, because two distributions is the only way to see which figures are
properties of the *format* and which are properties of the *data*.

Nothing was written to `fc18-pg`. One connection, `default_transaction_read_only
= on`, one `select * from feature_rows(...)`.

### The sample, on real rows

| | fixture rows | **real ONS rows** |
|---|---|---|
| cells × rows/cell × `k` | 96 × 128 × 100 | 96 × 128 × 100 |
| float64 payload (`matrix_bytes`) | 9,830,400 B | **9,830,400 B** |
| the same object dumped raw | 10,178,959 B | **10,280,399 B** |
| dumped `zlib` 1 | 1,207,032 B | 2,169,489 B |
| dumped **`zlib` 3** | 1,172,046 B | **1,967,996 B** |
| dumped `zlib` 6 | 1,159,438 B | 1,958,078 B |
| dumped `zlib` 9 | 1,095,794 B | 1,859,721 B |
| NaN fraction over the 1,228,800 cells | 0.2330 | **0.5603** |
| columns entirely NaN in the sample | 22/100 | **54/100** |

The real sample is *more* compressible than the fixture in absolute terms and
less in ratio (5.2× against 8.7×), and both figures are properties of the ONS
data rather than of zlib. The control says so: **uniform float64 noise at the
same shape** dumps to 9,830,641 B raw and only 9,322,743 B at `zlib` 3 — a 5%
saving. So the 80% is real structure (54 all-NaN columns, day-grain features
repeated across hours, a one-hot subsystem, `calendar_local_hour` constant
within a cell), not a codec trick, and a future window with fuller weather
coverage will compress **less**. The decision does not depend on the ratio: a
lossless representation is never worse than a raw one, and the worst case is
measured at 5%.

The 54 all-NaN columns are the real data and not a defect: weather coverage is
still partial (92 valid dates, quota-bound), and `dessem_free_v1` returns the
class-D block empty by construction. Every one of the 12,288 real background
rows holds at least one NaN — which is the same `null_headline_feature` gap
forecaster 30 left open and this ticket does not touch.

### The artifact, on the volume

The fixture fold's six boosters carrying the **real** 128-row sample, written
through `save_artifact` and read back through `load_artifact` seven times:

| | bundle on disk | `load_artifact` median | min |
|---|---|---|---|
| raw (what shipped) | 11,224,847 B | 50.6 ms | 50.1 ms |
| **`zlib` 3 (this ticket)** | **2,217,719 B** | **58.4 ms** | 57.2 ms |
| `zlib` 9 | 2,082,816 B | 57.9 ms | 56.5 ms |

Rest of the bundle, sample removed: **805,883 B** raw, 245,330 B at `zlib` 3 —
so forecaster 30's "roughly twelve times everything else" is confirmed on real
rows at 12.2×. The card is 26,962 B and is not compressed: it is the file an
operator reads with `cat`.

`zlib` 9 buys another 6% for 3.7× the dump time (0.615 s against 0.167 s on the
sample alone). Level 3 is the knee and `zlib` is in the standard library —
joblib prefers `lz4`, which **is not installed** (`ValueError: LZ4 is not
installed`, measured), and a dependency added to a deployment contract for 6%
is a worse trade than the 6%.

### What accumulates, and what the volume allows

- **2 serving lanes** (`SERVING_LANES` = early, late), **one retrain a week**,
  and **nothing is ever deleted** — a refused candidate is written on purpose,
  and `artifacts.py` has no prune path. Arithmetic over the measured artifact
  size: 1,167,384,088 B/year raw against 230,642,776 B/year compressed —
  **893 MiB a year saved**, 9,007,128 B per artifact.
- **A holdout backfill writes 12 more** (6 folds in `fold_calendar.yaml` × 2
  lanes): 134,698,164 B raw against 26,612,628 B.
- **There is no volume, and therefore no configured limit.** `railway.json` and
  `apps/ml/railway.json` declare no volume; the Dockerfile only creates
  `/data/models` as a mount point; `docker-compose.yml` uses a named docker
  volume with no size. The Railway `wattsteer` project's production environment
  holds **four services — api, worker, Postgres, Redis — and no ml service**,
  with two volumes, `postgres-data` and `redis-data`, **both 50,000 MB** and
  neither mounted at `/data/models`. So the honest statement is: the artifact
  volume does not exist yet, no size is configured anywhere in the tree, and
  when it is created the only precedent in the project is 50 GB. At that size,
  arithmetic over the measured artifact: 2,227 weeks of two lanes raw against
  11,272 compressed. **Nobody is about to run out of disk** — which is why this
  ticket is about the sample being the largest thing in the artifact for no
  reason, and not about an incident.
- **Nothing user-facing pays the +7.8 ms.** `load_promoted` is called from
  `/internal/publish/forecast` and `/internal/publish/diagnosis` and nowhere
  else in `app.py`; that is twice a day per lane, so ~31 ms a day across the
  service. And the read the frozen sample *replaced* was measured on the way in:
  17,376 real rows out of `feature_rows` over a 181-day window took **58.4
  seconds**. Forecaster 30's third argument is larger than it claimed.

## What the attribution actually reads, verified rather than assumed

The brief's most promising idea — store only the columns the driver groups read
— **does not exist**, and the code says so on real rows:

- `DriverGroupMap.group_of` raises `UngroupedFeatureError` for a name no group
  lists, and `assert_total_partition(real feature_names, DRIVER_GROUP_MAP)`
  **passes** against the live contract. The eight groups are a *total* partition:
  30 + 7 + 15 + 9 + 11 + 13 + 12 + 3 = **100 of 100 columns**, each exactly once
  (`sorted(union) == list(range(100))`, asserted).
- `_coalition_rows` tiles **`cell.matrix`** — the whole row block, all 100
  columns — 256 times and overwrites only `S`'s columns from the target. So at
  coalition `∅` every column of every background row is the value handed to `g`,
  and at the full coalition every column is the target's. `v(S)` reads all 100
  columns of all 128 rows at 254 of the 256 coalitions.

There is therefore **no column of a background row that goes unread**, and no
subset of them that could be dropped losslessly. The 54 columns that are
entirely NaN in the sample are not droppable either: NaN is a *value* LightGBM
splits on natively, no imputation happens anywhere in this repo, the sample must
be a matrix `k` wide under the bundle's own contract (`__post_init__` refuses one
that is not), and which columns are NaN is a property of one window rather than
of the contract. Compression already stores them for ~nothing.

## What was rejected, with the reason

- **Fewer than 128 rows per cell — rejected, and not close.**
  `docs/specs/diagnosis.md` asks for 128. `v(S)` is a Monte-Carlo mean over `B`,
  so halving `|B|` widens the standard error of every published `φ_j` by √2 and
  changes what every "typical" on the Explain screen *means*. That is a
  statistical change dressed as a size change, and the volume has room for
  eleven thousand artifacts. Not proposed, not flagged, not needed.
- **float32 — rejected.** Measured on the real sample: the round trip moves
  values by up to **5.941e-08** relative, and **96 of 96 cells** change under
  `matrix.tobytes()`. Forecaster 30 asserts determinism on those bytes with no
  tolerance, and it is right to: a booster's split thresholds are compared
  against the stored value, so a 6e-08 nudge can move a row across a split and
  change a published `φ`. It would have bought 4.9 MB of payload and cost the
  one property the sample was frozen for. Rejected on the measurement, not on
  taste.
- **Storing row indices instead of rows — rejected.** It is exactly the
  publish-time read forecaster 30 deleted, moved into the artifact: an index into
  a window is only a sample if the window's values have not changed, which is
  the point-in-time defect the whole ticket was about.
- **Deduplication across cells — nothing to gain.** Cells partition the block by
  `(subsystem, local_hour)`, so no row appears in two cells; measured, the 96
  cells share zero rows.

## What landed

- **`save_artifact` writes the bundle through
  `BUNDLE_COMPRESSION = ("zlib", 3)`**, one named constant in
  `training/bundle.py` carrying the measurements above, so the next reader can
  see what the level bought rather than guess why it is 3. The card is still
  written plain.
- **Nothing else changed.** `rows_per_cell` is still 128 and still the spec's
  default, the dtype is still float64, `matrix_bytes` still reports the sample's
  own payload rather than the day's file size, and no card key moved — the three
  card fields (`driver_group_version`, `driver_group_hash`,
  `headline_feature_check`) are a sibling's work and this ticket stayed out of
  the card path on purpose.
- **A truncated artifact is still a loud failure**, from the codec instead of
  the unpickler; `load_artifact` refuses either way and
  `test_an_interrupted_write_leaves_nothing_under_an_artifact_id` is unaffected,
  because `_atomically` still composes beside the destination.

**Status:** done

- [x] The cost is measured on real rows and not estimated: payload 9,830,400 B,
      artifact 11,224,847 B raw against 2,217,719 B compressed, rest of bundle
      805,883 B, `load_artifact` 50.6 ms raw against 58.4 ms compressed
- [x] What accumulates is measured and stated — 2 lanes weekly, nothing pruned,
      893 MiB/year saved — and the volume's limit is reported as what it is:
      no volume and no configured size, with 50,000 MB the only precedent in the
      project
- [x] What the attribution reads is verified in the code against the live
      contract: the eight driver groups are a total partition of all 100
      columns, `_coalition_rows` tiles the whole matrix, so no stored column is
      unread and nothing is droppable
- [x] `rows_per_cell` is unchanged at the spec's 128, and no argument against
      the spec was needed
- [x] The representation change is lossless, and it is proved on the bytes:
      `test_the_written_artifact_is_compressed_and_the_sample_survives_it` holds
      every cell's `matrix.tobytes()` and `dtype` against the drawn sample
      through `save_artifact` → `load_artifact`, with no tolerance
- [x] The guards can fail — both injections run and reverted (below)

### The guards, and the proof they can fail

- **`compress=` deleted from `save_artifact`**: **1 test fails** —
  `test_the_written_artifact_is_compressed_and_the_sample_survives_it`, on
  `assert bundle_path.read_bytes()[:1] == b"\x78"` (`assert b'\x80' == b'x'`; a
  zlib stream begins 0x78, a bare pickle begins with 0x80). So removing the
  saving is not silent, which is the failure mode a size decision actually has.
- **`MatchedBackground.__getstate__` casting matrices through float32** — the
  rejected representation, injected so the round-trip assertion is not
  decoration: **3 tests fail** —
  `test_the_written_artifact_is_compressed_and_the_sample_survives_it`,
  `test_a_reloaded_bundle_carries_the_same_sample_bit_for_bit` and
  `test_a_sample_survives_the_joblib_with_its_cells_still_sealed`.

Neither is vacuous: the size assertion is against a raw dump of the *same*
bundle rather than a literal (a literal would be a measurement of the fixture
fold), and the round-trip assertion compares `tobytes()` cell by cell over all
96 cells rather than comparing shapes.

### What is left open, and why

- **`load_promoted` has no cache.** Both publication routes load the bundle
  from disk on every call; at four calls a day that is 234 ms of unpickling and
  not worth a cache, but if a lane ever publishes hourly this is where the
  compression cost would show up first. Measured, not fixed.
- **Nothing prunes the volume.** Every candidate is kept for ever, on purpose.
  This ticket cut the slope by 5× and did not give the volume a retention rule;
  at 11,272 weeks of headroom that is a decision to make later, with the
  promotion log as the authority for what may not be deleted.
- **The compression ratio will fall as weather coverage rises.** 54 of 100
  columns are entirely NaN in today's real sample. When data-platform finishes
  the ~1,782 owed Open-Meteo calls the sample gets denser and the artifact gets
  bigger; the noise control says the floor is 9.3 MB per sample in the limit of
  incompressible data. The saving is real, and it is not a promise about 2027.
- **The `null_headline_feature` gap is unchanged.** Every one of the 12,288 real
  background rows holds at least one NaN, so a lane trained on this window would
  refuse every publication exactly as forecaster 30 described. That is
  api-surface's box and this ticket measured it rather than moving it.
