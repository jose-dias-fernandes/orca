import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cgroupV2MemoryDirCandidates,
  parseCgroupMemoryBytes,
  parseCgroupMemoryEvent,
  parseCgroupV2Path,
  readLinuxCgroupMemoryLimit,
  setLinuxCgroupMemoryLimitReaderForTest
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
  setSystemMemoryInfoReaderForTest(null)
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
    const events = 'low 0\nhigh 12\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n'
    expect(parseCgroupMemoryEvent(events, 'oom_kill')).toBe(1)
    expect(parseCgroupMemoryEvent(events, 'high')).toBe(12)
    // `oom` must not answer for `oom_kill`: only the latter means a task died.
    expect(parseCgroupMemoryEvent('low 0\nhigh 0\n', 'oom_kill')).toBeUndefined()
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
