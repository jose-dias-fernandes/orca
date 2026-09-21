import { createElement, type ComponentType } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SwitchDependencies = {
  storage: Map<string, string>
  /** What bounds the neutral window on a released phone; see the last case in this file. */
  reads: number
  /** Committed mounts, not renders: React may discard a render, and what this file is about is
   *  what the user was shown. */
  natives: string[]
  shells: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): SwitchDependencies => ({
  storage: new Map(),
  reads: 0,
  natives: [],
  shells: [],
  params: {}
}))

const nativeScreen = vi.hoisted(
  () =>
    async (name: string): Promise<ComponentType<Record<string, unknown>>> => {
      const React = await import('react')
      return function NativeScreen() {
        React.useEffect(() => {
          dependencies.natives.push(name)
        }, [])
        return null
      }
    }
)

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      dependencies.reads += 1
      return dependencies.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({ setParams: () => {} })
}))

vi.mock('./MobileWebShellScreen', async () => {
  const React = await import('react')
  return {
    MobileWebShellScreen: (props: { route: { pathname: string } }) => {
      const pathname = React.useRef(props.route.pathname)
      React.useEffect(() => {
        dependencies.shells.push(pathname.current)
      }, [])
      return null
    }
  }
})

vi.mock('../host-screen/HostScreen', async () => ({ HostScreen: await nativeScreen('host-list') }))
vi.mock('../components/WorkspaceDetailPlaceholder', async () => ({
  WorkspaceDetailPlaceholder: await nativeScreen('workspace-detail-placeholder')
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false })
}))
vi.mock('../tasks/MobileTasksScreen', async () => ({
  MobileTasksScreen: await nativeScreen('tasks')
}))
vi.mock('../agent-history/MobileAgentSessionHistoryPanel', async () => ({
  MobileAgentSessionHistoryPanel: await nativeScreen('agent-history')
}))
vi.mock('../files/MobileFileExplorerPanel', async () => ({
  MobileFileExplorerPanel: await nativeScreen('files')
}))
vi.mock('../files/MobileFilePreviewScreen', async () => ({
  MobileFilePreviewScreen: await nativeScreen('files-preview')
}))
vi.mock('../source-control/MobileSourceControlPanel', async () => ({
  MobileSourceControlPanel: await nativeScreen('source-control')
}))
vi.mock('../session/MobileDiffReviewRouteScreen', async () => ({
  MobileDiffReviewRouteScreen: await nativeScreen('review')
}))
vi.mock('../session/MobileSessionRouteScreen', async () => ({
  MobileSessionRouteScreen: await nativeScreen('session')
}))
vi.mock('./PageRouteUnavailableScreen', async () => ({
  PageRouteUnavailableScreen: await nativeScreen('catch-all')
}))

import HostListRoute from '../../app/h/[hostId]/index'
import TasksRoute from '../../app/h/[hostId]/tasks'
import AgentHistoryRoute from '../../app/h/[hostId]/agent-history/[worktreeId]'
import FilesRoute from '../../app/h/[hostId]/files/[worktreeId]'
import FilesPreviewRoute from '../../app/h/[hostId]/files/preview/[worktreeId]'
import SourceControlRoute from '../../app/h/[hostId]/source-control/[worktreeId]'
import ReviewRoute from '../../app/h/[hostId]/review/[worktreeId]'
import SessionRoute from '../../app/h/[hostId]/session/[worktreeId]'
import CatchAllRoute from './catch-all-page-route'

const FLAG_KEY = 'orca:mobileWebShellEnabled'

/**
 * Every switch the hybrid shell flag decides, with the params each needs to name a route the shell
 * could open. `native` is what that switch renders when the flag is off — a panel for most of them
 * and the refusal screen for the catch-all, which has no native screen behind it.
 */
type SwitchCase = {
  readonly name: string
  readonly Route: ComponentType
  readonly params: Record<string, string | string[]>
  /** What the mocked native screen pushes when it mounts. */
  readonly native: string
  readonly pathname: string
}

const SWITCHES: readonly SwitchCase[] = [
  {
    name: 'host list',
    Route: HostListRoute,
    params: { hostId: 'host-1' },
    native: 'host-list',
    pathname: '/h/host-1'
  },
  {
    name: 'tasks',
    Route: TasksRoute,
    params: { hostId: 'host-1' },
    native: 'tasks',
    pathname: '/h/host-1/tasks'
  },
  {
    name: 'agent history',
    Route: AgentHistoryRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'agent-history',
    pathname: '/h/host-1/agent-history/wt-1'
  },
  {
    name: 'files',
    Route: FilesRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'files',
    pathname: '/h/host-1/files/wt-1'
  },
  {
    name: 'file preview',
    Route: FilesPreviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1', relativePath: 'src/index.ts' },
    native: 'files-preview',
    pathname: '/h/host-1/files/preview/wt-1'
  },
  {
    name: 'source control',
    Route: SourceControlRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'source-control',
    pathname: '/h/host-1/source-control/wt-1'
  },
  {
    name: 'review',
    Route: ReviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'review',
    pathname: '/h/host-1/review/wt-1'
  },
  {
    name: 'session',
    Route: SessionRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'session',
    pathname: '/h/host-1/session/wt-1'
  },
  {
    name: 'catch-all',
    Route: CatchAllRoute,
    params: { hostId: 'host-1', page: ['settings'] },
    native: 'catch-all',
    pathname: '/h/host-1/settings'
  }
]

/** Host elements are matched by name: React's `ElementType` does not admit a host name, so the
 *  typed form is a predicate. */
function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

/** Renders without settling the flag read: no `await` inside `act`, so the effect's promise is
 *  deliberately left pending and the switch is caught in its unresolved window. */
function renderUnsettled(Route: ComponentType): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Route))
  })
  if (rendered.tree === null) {
    throw new Error('the switch did not render')
  }
  return rendered.tree
}

describe.each(SWITCHES)('the $name switch while the flag is unresolved', (entry) => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.reads = 0
    dependencies.natives.length = 0
    dependencies.shells.length = 0
    dependencies.params = { ...entry.params }
    Object.assign(globalThis, { __DEV__: true })
  })

  it('mounts neither renderer, and paints the neutral state instead', async () => {
    dependencies.storage.set(FLAG_KEY, 'true')
    const tree = renderUnsettled(entry.Route)
    expect(dependencies.natives).toEqual([])
    expect(dependencies.shells).toEqual([])
    expect(byName(tree, 'ActivityIndicator')).toHaveLength(1)
    await act(async () => {})
  })

  it('mounts the shell once when the read resolves on, having never mounted native', async () => {
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    await act(async () => {})
    expect(dependencies.natives).toEqual([])
    expect(dependencies.shells).toEqual([entry.pathname])
  })

  it('mounts native once when the read resolves off, and nothing else', async () => {
    const tree = renderUnsettled(entry.Route)
    await act(async () => {})
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
    expect(byName(tree, 'ActivityIndicator')).toEqual([])
  })

  it('reaches no storage at all on a release build, which is what bounds the window', async () => {
    // How long a released phone spends on the neutral state, which is the only thing this change
    // costs a user with the flag off. `loadMobileWebShellEnabled` answers `false` outside `__DEV__`
    // before it looks at the key, so the window is not an AsyncStorage round trip across the
    // bridge — it is React's own passive-effect flush and one microtask, and the switch has its
    // answer on the first turn after the first commit.
    Object.assign(globalThis, { __DEV__: false })
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    await act(async () => {
      await Promise.resolve()
    })
    expect(dependencies.reads).toBe(0)
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
  })
})
