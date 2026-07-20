# Local patch to `sqlite.worker.js`

`sqlite.worker.js` is vendored (not installed via npm) and has been
hand-patched to fix a real bug in `serverMode: "chunked"` mode. If this
library is ever upgraded/re-vendored, re-apply this patch or the bug will
come back.

## The bug

`sqlite.worker.js`'s chunked-mode `rangeMapper` computes which physical
chunk file (`database.sqlite.NNN`) to fetch from using only the **start**
byte of a requested range, then blindly re-bases the **end** byte into that
same file — without checking whether the range actually crosses into the
next physical chunk file.

`LazyUint8Array`'s read-ahead heuristic ("read heads") doubles its burst
size on each sequential hit, up to `maxReadSpeed` (default 5 MB). Once a
read head's position lands within the last `maxReadSpeed` bytes of a
physical chunk file (`serverChunkSize`, 40 MB here), its next burst request
spills past that file's end. The server returns fewer bytes than requested;
`getChunk()`'s fill loop breaks early, and the originally-requested chunk is
left unfilled, throwing:

```
Error: doXHR failed (bug)!
```

This reproduced deterministically (not a race/concurrency issue — a brand
new connection hits it too) for large, scattered queries — e.g. fetching
every year of a single county's migration data, which touches rows spread
across the whole ~800 MB+ file. Smaller/more localized queries were less
likely to straddle a boundary, which is why it looked like an intermittent
or usage-pattern-dependent bug from the app side.

As the database has grown across Phase 11 (adding earlier and earlier
years), the number of 40 MB physical chunk boundaries has grown too, making
this increasingly likely to hit.

## The fix

Three changes, all in `sqlite.worker.js`:

1. `LazyUint8Array`'s constructor now stores `this.serverChunkSize` from the
   config (previously discarded).
2. `SplitFileHttpDatabase`'s `createLazyFile(...)` call now passes
   `serverChunkSize` through when `serverMode === "chunked"`.
3. `doXHR(e, t)` now checks whether `[e, t]` crosses a `serverChunkSize`
   boundary. If so, it splits the request into one sub-request per physical
   file segment (via the new `_fetchRange` helper, factored out of the
   original single-request body), and concatenates the resulting buffers
   into one combined `ArrayBuffer` — exactly what the caller expects from a
   single contiguous read. Non-crossing requests are unaffected (single
   `_fetchRange` call, same as before).

To see the pre-patch version of the file, check it out from git history
(the commit before this patch was introduced), e.g.:

```
git log --follow -- libs/sql.js-httpvfs/sqlite.worker.js
git show <commit-before-patch>:libs/sql.js-httpvfs/sqlite.worker.js
```
