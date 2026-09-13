# Reading a Linux SIGKILL in a crash report

A Linux renderer that dies with `reason=killed exitCode=9` was sent `SIGKILL` by
something. The crash report used to carry only `/proc/meminfo` — host-wide free
memory and swap — which answers a question nobody asked. All three killers below
can fire while `systemMemoryAvailableMB` is in the gigabytes and swap is
untouched, so that field alone cannot name any of them.

Three v1.4.200 field reports are the worked examples:

| Report     | What it showed                                                                  |
| ---------- | ------------------------------------------------------------------------------- |
| `2ea53f9c` | Lone renderer exit 9. 20518 MB available, swap 64009/64009 — 100% free          |
| `ad185d76` | Renderer exit 9. 6471 MB available, swap 31351/31351 — 100% free                |
| `181e8e36` | Renderer exit 9 **and** a `process_gone_suppressed` GPU exit 9 in the same tree |

The kernel OOM killer does not fire with that much headroom. Two processes in
one tree dying together (`181e8e36`) is a whole-cgroup kill, not a per-process
one. None of that was provable from the report, so all three were closed
unattributed.

## The three killers

| Killer            | Fires on                                         | Host free memory at the time |
| ----------------- | ------------------------------------------------ | ---------------------------- |
| Kernel OOM killer | An allocation that cannot be satisfied           | Near zero                    |
| `systemd-oomd`    | PSI memory **stall**, sustained                  | Can be gigabytes             |
| Something else    | A person, a supervisor, a sandbox, the OOM score | Anything                     |

`systemd-oomd` is default-enabled on Arch and Fedora. It watches a cgroup's
`memory.pressure` and kills the **whole cgroup** when `full avg10` stays above
its limit (50–60% by default) for `DefaultMemoryPressureDurationSec` (30 s).
Stall means time spent waiting on memory — reclaim, refault, swap-in — which a
machine with plenty of nominally free memory can do continuously.

## The fields

Emitted only on Linux, only when readable, and omitted entirely rather than
reported as zero when they are not. Each appears twice: once for the reading
taken at process-gone, and once as `systemMemoryPreGone*` for the sample taken
up to 10 s before it (see `pre-gone-host-memory.ts`).

| Field                                                | Source                         |
| ---------------------------------------------------- | ------------------------------ |
| `systemMemoryCgroupMaxMB` / `HighMB` / `CurrentMB`   | cgroup v2 `memory.max` etc.    |
| `systemMemoryCgroupOomKillCount`                     | `memory.events` `oom_kill`     |
| `systemMemoryCgroupMaxEventCount` / `HighEventCount` | `memory.events` `max` / `high` |
| `systemMemoryStall{Some,Full}Avg{10,60}Pct`          | `/proc/pressure/memory`        |
| `systemMemoryCgroupStall{Some,Full}Avg{10,60}Pct`    | the cgroup's `memory.pressure` |

An absent row means "could not measure", never "calm" — with one exception to
read carefully: `memory.max` and `memory.high` read the literal string `max`
when no ceiling is set, and that is reported as an absent `CgroupMaxMB` /
`CgroupHighMB`, not as a number. So the ceiling fields alone cannot separate "no
ceiling" from "unreadable"; `systemMemoryCgroupCurrentMB` is the tell. Present
means the cgroup was read and the missing ceiling really is unlimited; no
`Cgroup*` field at all means nothing was measurable. cgroup v1
is not read at all: its limit is not resolvable from `/proc/self/cgroup` without
mount parsing, and a half-right ceiling is worse than none.

## How to attribute a kill

Read the pre-gone and gone-time pair, in this order.

1. **Did `systemMemoryCgroupOomKillCount` step up across the death?**
   `systemMemoryPreGoneCgroupOomKillCount` 3 → `systemMemoryCgroupOomKillCount` 4
   is the kernel OOM killer acting inside our cgroup. This is the only decisive
   datum; an absolute count on its own proves nothing, because the cgroup may
   have OOMed an hour ago. Unchanged rules the cgroup OOM killer out.
2. **Was `systemMemoryCgroupMaxMB` (or `HighMB`) set, with `CurrentMB` near it?**
   A ceiling below host RAM means the machine's spare memory was never available
   to us. This is the answer for a systemd unit with `MemoryMax`, a Flatpak or
   snap sandbox, or a container.
3. **Was `systemMemoryPreGoneCgroupStallFullAvg10Pct` high with memory free?**
   That is `systemd-oomd`. Read the **pre-gone** value: PSI decays, and the
   gone-time reading is taken after the corpse released its pages, so it
   routinely understates the stall that caused the kill. Corroborate with
   `journalctl -u systemd-oomd` on the reporting host if it is reachable.
4. **All three quiet, plenty of memory, and a sibling process also exit 9?**
   Whole-tree kill from outside: a supervisor, a session teardown, `pkill`. Do
   not spend the investigation on memory.

## The summary label

`systemMemoryPressureSignal` already carried `mem-available` for every Linux
reading with a `MemAvailable` field. That value keeps exactly its old meaning;
two more specific values now sit beside it:

- `mem-available-cgroup-capped` — a cgroup ceiling below host RAM, so
  `systemMemoryAvailableMB` describes memory we could never have had.
- `mem-available-stalled` — `full avg10` at or above
  `MEMORY_STALL_HIGH_AVG10_PERCENT` (30%, deliberately under oomd's trip point,
  because the reading is taken after the kill and is already decaying).

A ceiling outranks stall, because the ceiling explains the stall as well as the
kill. Both keep the `mem-available` prefix, so a reader matching the family by
prefix is unaffected and one matching the old exact value at worst loses the
refinement — see [remote-wire-compatibility.md](./remote-wire-compatibility.md).
The label is a summary; the numbered checks above are the attribution, and the
raw fields stay readable whatever the label says.

## Where the code is

- `src/main/crash-reporting/linux-cgroup-memory-limit.ts` — cgroup v2 resolution
  and `memory.*` reads. Probes both the path from `/proc/self/cgroup` and the
  mount root, because a cgroup namespace mounts our own cgroup at the root.
- `src/main/crash-reporting/linux-memory-pressure-stall.ts` — PSI parsing.
- `src/main/crash-reporting/system-memory-details.ts` — field naming and label.

Both readers are platform-guarded, swallow every read failure, and return
`undefined` rather than a row of zeroes. PSI is missing on kernels without
`CONFIG_PSI` and on most WSL2 kernels; cgroup files are missing on hardened
hosts. That is a normal answer here, not an error to report.
