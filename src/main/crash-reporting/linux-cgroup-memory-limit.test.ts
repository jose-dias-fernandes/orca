import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cgroupV2MemoryDirCandidates,
  parseCgroupMemoryBytes,
  parseCgroupMemoryEvent,
  parseCgroupV2Path,
  readLinuxCgroupMemoryLimit,
  resolveCgroupV2MemoryDir,
  setLinuxCgroupMemoryLimitReaderForTest,
  setLinuxPseudoFileReaderForTest
} from './linux-cgroup-memory-limit'
import { setLinuxMemoryPressureStallReaderForTest } from './linux-memory-pressure-stall'
import { getSystemMemoryDetails, setSystemMemoryInfoReaderForTest } from './system-memory-details'
import {
  preGoneSystemMemoryDetails,
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'

// The host reading from field report 2ea53f9c: a lone renderer SIGKILLed while
// /proc/meminfo says 20 GB available and swap is 100% free.
const NO_HOST_PRESSURE = {
  total: 32_005 * 1024,
  free: 10_326 * 1024,
  available: 20_518 * 1024,
  swapTotal: 64_009 * 1024,
  swapFree: 64_009 * 1024
}

beforeEach(() => {
  // Without this the real readers answer from the CI host's own /proc and /sys.
  setLinuxMemoryPressureStallReaderForTest(() => undefined)
})

afterEach(() => {
  setLinuxCgroupMemoryLimitReaderForTest(null)
  setLinuxMemoryPressureStallReaderForTest(null)
  setLinuxPseudoFileReaderForTest(null)
  setSystemMemoryInfoReaderForTest(null)
})

/** Only the listed paths exist; anything else reads as an unreadable pseudo-file. */
function fakeLinuxPseudoFiles(files: Record<string, string>): void {
  setLinuxPseudoFileReaderForTest((filePath) => files[filePath])
}

const SANDBOX_CGROUP_PATH = '0::/user.slice/user-1000.slice/app.slice/orca.scope\n'

// Everything below the seam that the reader test double skips: which directory
// the sysfs reads actually land in, and whether an unresolvable one stays quiet.
describe('cgroup v2 memory directory resolution', () => {
  it('reads the directory /proc/self/cgroup names when it exists', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '512\n'
    })

    expect(resolveCgroupV2MemoryDir()).toBe(
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope'
    )
  })

  it('falls back to the mount root, which is our own cgroup inside a namespace', () => {
    // The sandbox case the header claims to cover: the reported path is a host
    // path that does not exist in here, and the mount root IS our cgroup.
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/memory.current': '900000000\n',
      '/sys/fs/cgroup/memory.max': '1073741824\n'
    })

    expect(resolveCgroupV2MemoryDir()).toBe('/sys/fs/cgroup')
    expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
      maxBytes: 1_073_741_824,
      currentBytes: 900_000_000
    })
  })

  it('claims nothing when neither candidate has memory.current', () => {
    // A v1-only or hybrid host: the unified root exists but carries no memory
    // controller, and the host root cgroup never has memory.current.
    fakeLinuxPseudoFiles({ '/proc/self/cgroup': SANDBOX_CGROUP_PATH })

    expect(resolveCgroupV2MemoryDir()).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })

  it('reads the ceiling, the throttle and the events off the resolved directory', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '4200000000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.max': '4294967296',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.high': 'max\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.events':
        // `oom` deliberately differs from `oom_kill`: reading the wrong one here
        // would report a cgroup that went OOM without killing anything.
        'low 0\nhigh 7\nmax 2\noom 5\noom_kill 1\n'
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({
      maxBytes: 4_294_967_296,
      // `max` is no ceiling, and must not surface as one just because it was read.
      highBytes: undefined,
      currentBytes: 4_200_000_000,
      oomKillCount: 1,
      maxEventCount: 2,
      highEventCount: 7
    })
  })

  it('does not turn a zero-length ceiling file into a 0 MB cap', () => {
    // A sandbox that stubs /sys/fs/cgroup with empty files: `Number('')` is 0, so
    // dropping the empty-string term ships a 0 MB ceiling and labels the report
    // cgroup-capped — a killer named off a file that measured nothing.
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => undefined)
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '4200000000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.max': '',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.high': ''
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({
      maxBytes: undefined,
      highBytes: undefined,
      currentBytes: 4_200_000_000,
      oomKillCount: undefined,
      maxEventCount: undefined,
      highEventCount: undefined
    })

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
    expect(details.systemMemoryCgroupHighMB).toBeUndefined()
    expect(details.systemMemoryCgroupCurrentMB).toBe(4_005)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('says nothing rather than a row of undefineds when the files are garbage', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': 'max'
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })
})

describe('linux cgroup v2 memory limit', () => {
  it('takes the unified-hierarchy line, not a v1 controller line', () => {
    const procSelfCgroup = [
      '12:pids:/user.slice/user-1000.slice',
      '1:name=systemd:/user.slice/user-1000.slice',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'
    ].join('\n')
    expect(parseCgroupV2Path(procSelfCgroup)).toBe(
      '/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'
    )
    expect(parseCgroupV2Path('12:pids:/user.slice')).toBeUndefined()
  })

  it('probes the mount root too, because a sandbox mounts our cgroup there', () => {
    expect(cgroupV2MemoryDirCandidates('/user.slice/orca.scope')).toEqual([
      '/sys/fs/cgroup/user.slice/orca.scope',
      '/sys/fs/cgroup'
    ])
    // A cgroup namespace already reports "/", so the root is the only candidate.
    expect(cgroupV2MemoryDirCandidates('/')).toEqual(['/sys/fs/cgroup'])
    expect(cgroupV2MemoryDirCandidates(undefined)).toEqual(['/sys/fs/cgroup'])
  })

  it('reads `max` as no limit rather than as a numeric ceiling', () => {
    expect(parseCgroupMemoryBytes('max\n')).toBeUndefined()
    expect(parseCgroupMemoryBytes('2147483648\n')).toBe(2_147_483_648)
    expect(parseCgroupMemoryBytes(undefined)).toBeUndefined()
  })

  it('pulls oom_kill out of memory.events', () => {
    // A cgroup can go OOM and reclaim without killing anything, so `oom` runs
    // ahead of `oom_kill` on a real host and only the latter attributes a death.
    const events = 'low 0\nhigh 12\nmax 3\noom 5\noom_kill 1\noom_group_kill 0\n'
    expect(parseCgroupMemoryEvent(events, 'oom_kill')).toBe(1)
    expect(parseCgroupMemoryEvent(events, 'oom')).toBe(5)
    expect(parseCgroupMemoryEvent(events, 'high')).toBe(12)
    // A prefix or substring match would answer `oom_kill` with `oom`'s count.
    expect(parseCgroupMemoryEvent('low 0\nhigh 0\noom 5\n', 'oom_kill')).toBeUndefined()
  })

  it('stays silent off Linux', () => {
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 1 }))
    expect(readLinuxCgroupMemoryLimit('darwin')).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('win32')).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({ maxBytes: 1 })
  })

  it('never lets a sysfs failure break the reading', () => {
    setLinuxCgroupMemoryLimitReaderForTest(() => {
      throw new Error('EACCES')
    })
    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })
})

describe('cgroup-capped linux crash memory details', () => {
  it('carries the ceiling and the kernel oom_kill counter the host reading cannot see', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: 1_073_741_824,
      currentBytes: 1_020_000_000,
      oomKillCount: 1,
      maxEventCount: 4
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryAvailableMB).toBe(20_518)
    expect(details.systemMemoryCgroupMaxMB).toBe(1024)
    expect(details.systemMemoryCgroupCurrentMB).toBe(973)
    expect(details.systemMemoryCgroupOomKillCount).toBe(1)
    expect(details.systemMemoryCgroupMaxEventCount).toBe(4)
    // The whole point: 20 GB "available" must no longer read as "no ceiling".
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('keeps the plain label when the cgroup declares no ceiling', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ oomKillCount: 0 }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupOomKillCount).toBe(0)
    expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('keeps the plain label when the ceiling is not below host RAM', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    // A container whose memory.max was set to the whole machine: a ceiling, but
    // not one that made the 20 GB beside it unreachable, so it explains nothing.
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 32_005 * 1024 * 1024 }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupMaxMB).toBe(32_005)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('treats a ceiling as capping when the host total is unreadable', () => {
    // MemTotal missing but MemAvailable present: the comparison that would clear
    // this ceiling cannot be made, so the ceiling must not be waved through. The
    // value is deliberately huge — nothing but the unknown-total term can cap it.
    const { total: _total, ...noTotal } = NO_HOST_PRESSURE
    setSystemMemoryInfoReaderForTest(() => noTotal)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 512 * 1024 * 1024 * 1024 }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryTotalMB).toBeUndefined()
    expect(details.systemMemoryCgroupMaxMB).toBe(524_288)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('caps on memory.high alone, which throttles us long before memory.max would', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: undefined,
      highBytes: 2_147_483_648
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupHighMB).toBe(2_048)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('takes the lower ceiling when a unit sets both MemoryHigh and MemoryMax', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    // The systemd pair: MemoryMax above host RAM is no ceiling at all, and only
    // the MemoryHigh below it explains a kill with 20 GB "available" beside it.
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: 48 * 1024 * 1024 * 1024,
      highBytes: 2 * 1024 * 1024 * 1024
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupMaxMB).toBe(49_152)
    expect(details.systemMemoryCgroupHighMB).toBe(2_048)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('adds nothing on a host with no v2 memory controller', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => undefined)

    const details = getSystemMemoryDetails('linux')

    expect(Object.keys(details).some((key) => key.includes('Cgroup'))).toBe(false)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('reads none of this on macOS or Windows', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 1_073_741_824 }))

    for (const platform of ['darwin', 'win32'] as const) {
      const details = getSystemMemoryDetails(platform)
      expect(Object.keys(details).some((key) => key.includes('Cgroup'))).toBe(false)
    }
  })
})

// Why the pair and not one reading: an absolute oom_kill count says nothing —
// the cgroup may have OOMed an hour ago. Only the STEP across the death proves
// the kernel did this one, and an unchanged counter rules the cgroup out.
describe('oom_kill counter across a process death', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    resetPreGoneSystemMemorySamplingForTest()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    resetPreGoneSystemMemorySamplingForTest()
  })

  it('reports the pre-gone counter beside the gone-time one', async () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    let oomKillCount = 3
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: 4_294_967_296,
      currentBytes: 4_200_000_000,
      oomKillCount
    }))

    await samplePreGoneSystemMemory(1_000)
    oomKillCount = 4
    const report = {
      ...getSystemMemoryDetails('linux'),
      ...preGoneSystemMemoryDetails(2_500)
    }

    expect(report.systemMemoryPreGoneCgroupOomKillCount).toBe(3)
    expect(report.systemMemoryCgroupOomKillCount).toBe(4)
    expect(report.systemMemoryPreGoneSampleAgeMs).toBe(1_500)
    expect(report.systemMemoryPreGonePressureSignal).toBe('mem-available-cgroup-capped')
  })
})
