import { readFileSync } from 'node:fs'

// ─── cgroup v2 memory accounting for Linux crash reports ────────────
// Why: /proc/meminfo — which `process.getSystemMemoryInfo()` reads, and which is
// the entire Linux memory story a crash report currently tells — is host-wide
// and knows nothing about the cgroup Orca actually runs in. A systemd user unit
// with MemoryMax, a Flatpak/snap sandbox or a container kills our renderer with
// SIGKILL while MemAvailable sits at 20 GB and swap is 100% free, so the report
// reads "plenty of memory" and the death is unexplainable (field report
// 2ea53f9c: lone renderer exit 9, no siblings, no pressure).
//
// `memory.events`' `oom_kill` is the decisive datum and the reason this exists:
// the kernel increments it exactly when it OOM-kills a task in our cgroup. The
// pre-gone sampler carries an earlier reading of the same counter, so a report
// that shows it stepping across the death says the kernel did it — and one that
// shows it unchanged rules the cgroup out, leaving systemd-oomd or an external
// kill (see docs/reference/linux-memory-kill-attribution.md).
//
// v1 is deliberately unsupported: its hierarchy is per-controller and its limit
// is unreadable from `/proc/self/cgroup` alone without mount parsing, and a
// half-right limit is worse than an absent one here.

const CGROUP_V2_MOUNT = '/sys/fs/cgroup'
const BYTES_PER_MB = 1024 * 1024

export type LinuxCgroupMemoryLimit = {
  /** Bytes, or undefined when the file reads `max` (no limit). */
  maxBytes?: number
  highBytes?: number
  currentBytes?: number
  /** Kernel OOM kills of a task in this cgroup or below it, since its creation. */
  oomKillCount?: number
  /** Times usage would have exceeded `memory.max`. */
  maxEventCount?: number
  /** Times usage was throttled against `memory.high`. */
  highEventCount?: number
}

type LinuxCgroupMemoryLimitReader = () => LinuxCgroupMemoryLimit | undefined

/** Absent is a normal answer here: hardened hosts, WSL and containers hide these. */
export function readLinuxPseudoFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/** The unified-hierarchy line is the one with an empty controller list. */
export function parseCgroupV2Path(procSelfCgroup: string): string | undefined {
  for (const line of procSelfCgroup.split('\n')) {
    if (line.startsWith('0::')) {
      const relative = line.slice('0::'.length).trim()
      return relative.startsWith('/') ? relative : undefined
    }
  }
  return undefined
}

/**
 * Where this process's cgroup memory files could be, best candidate first.
 *
 * Under a cgroup namespace (containers, some Flatpak runtimes) the mount root IS
 * our cgroup and the path `/proc/self/cgroup` reports names a directory that does
 * not exist inside; with a host cgroupns it is the other way round. Probing both
 * is the difference between a readable limit and nothing at all in a sandbox.
 */
export function cgroupV2MemoryDirCandidates(relative: string | undefined): string[] {
  return relative === undefined || relative === '/'
    ? [CGROUP_V2_MOUNT]
    : [`${CGROUP_V2_MOUNT}${relative}`, CGROUP_V2_MOUNT]
}

export function resolveCgroupV2MemoryDir(): string | undefined {
  const relative = parseCgroupV2Path(readLinuxPseudoFile('/proc/self/cgroup') ?? '')
  return cgroupV2MemoryDirCandidates(relative).find(
    // The root cgroup has no memory.current, so this also rejects the host root.
    (dir) => readLinuxPseudoFile(`${dir}/memory.current`) !== undefined
  )
}

/** `max` means unlimited, and must not be reported as a numeric ceiling. */
export function parseCgroupMemoryBytes(raw: string | undefined): number | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '' || value === 'max') {
    return undefined
  }
  const bytes = Number(value)
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined
}

export function parseCgroupMemoryEvent(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  for (const line of raw.split('\n')) {
    const [name, count] = line.trim().split(/\s+/)
    if (name === key) {
      const value = Number(count)
      return Number.isFinite(value) ? value : undefined
    }
  }
  return undefined
}

function readLinuxCgroupMemoryLimitFromSysfs(): LinuxCgroupMemoryLimit | undefined {
  const dir = resolveCgroupV2MemoryDir()
  if (dir === undefined) {
    return undefined
  }
  // memory.events is hierarchical, so a renderer in a descendant cgroup still counts.
  const events = readLinuxPseudoFile(`${dir}/memory.events`)
  const limit: LinuxCgroupMemoryLimit = {
    maxBytes: parseCgroupMemoryBytes(readLinuxPseudoFile(`${dir}/memory.max`)),
    highBytes: parseCgroupMemoryBytes(readLinuxPseudoFile(`${dir}/memory.high`)),
    currentBytes: parseCgroupMemoryBytes(readLinuxPseudoFile(`${dir}/memory.current`)),
    oomKillCount: parseCgroupMemoryEvent(events, 'oom_kill'),
    maxEventCount: parseCgroupMemoryEvent(events, 'max'),
    highEventCount: parseCgroupMemoryEvent(events, 'high')
  }
  // Nothing readable means no v2 memory controller here; say nothing rather
  // than ship a row of undefineds that reads as "measured, and unlimited".
  return Object.values(limit).some((value) => value !== undefined) ? limit : undefined
}

let reader: LinuxCgroupMemoryLimitReader = readLinuxCgroupMemoryLimitFromSysfs

export function setLinuxCgroupMemoryLimitReaderForTest(
  next: LinuxCgroupMemoryLimitReader | null
): void {
  reader = next ?? readLinuxCgroupMemoryLimitFromSysfs
}

export function readLinuxCgroupMemoryLimit(
  platform: NodeJS.Platform = process.platform
): LinuxCgroupMemoryLimit | undefined {
  if (platform !== 'linux') {
    return undefined
  }
  try {
    return reader()
  } catch {
    return undefined
  }
}

export function cgroupMemoryBytesToMB(bytes: number | undefined): number | undefined {
  return bytes === undefined ? undefined : Math.round(Math.max(0, bytes) / BYTES_PER_MB)
}
