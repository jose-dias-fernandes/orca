/**
 * The mic control on the page, driven by the real seam over the real shell.
 *
 * Ruling 4's negative proof, now with something behind it: on a route the shell did not grant the
 * audio verbs the control has to report the refusal and come back, rather than crash or sit on
 * "Starting voice dictation" forever. On a route that was granted them it has to reach recording —
 * which is the whole of the item, observed where a user would see it.
 *
 * Mounted against `dictation-capture.web.ts` rather than the native sibling, because that is the
 * substitution the web build makes: the bundler resolves `.web.ts` first and vitest resolves the
 * native file. Everything else is real — the port pair, the verb table, the shell's ring.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer needs host elements, not the real platform: what this observes is the label the
// control carries and the tap that reaches its handler, neither of which is native.
vi.mock('react-native', () => ({
  ActivityIndicator: (props: Record<string, unknown>) =>
    createElement('rn-activity-indicator', props),
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
  Pressable: (props: { children?: ReactNode }) =>
    createElement('rn-pressable', props, props.children)
}))
vi.mock('lucide-react-native', () => ({
  ImagePlus: (props: Record<string, unknown>) => createElement('lucide-image-plus', props),
  Mic: (props: Record<string, unknown>) => createElement('lucide-mic', props)
}))

// The page's capture seam, which is what the web build resolves.
vi.mock(
  '../platform/dictation-capture',
  async () => await import('../platform/dictation-capture.web')
)

// The provider module re-exports the screen hooks, and reaching the real ones imports the Expo
// runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createNativeAudioCapture, type NativeAudioEngine } from '../platform/native-audio'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'

/** Every message that reached the composer's own error handler, which is what it toasts. */
const reported: string[] = []

/** Every hold and release the shell's capture asked the device for, as `+` and `-`. */
const screen: string[] = []

/** The three verbs served by the real handlers over an engine that opens and produces no audio. */
function createAudioShell(): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const engine: NativeAudioEngine = {
    requestPermission: async () => 'granted',
    open: async (sampleRate) => ({ opened: true, sampleRate }),
    begin: () => true,
    end: () => {},
    onMicrophoneData: () => ({ remove: () => {} }),
    onInterruption: () => ({ remove: () => {} }),
    screenLock: {
      hold: () => screen.push('+'),
      release: () => screen.push('-')
    }
  }
  const capture = createNativeAudioCapture(engine)
  return (verb, params) => capture.serve(verb, params)
}

function Composer({ pair }: { pair: BridgePortPair }): ReactElement {
  const dictation = useMobileDictation({
    client: pair.client,
    enabled: true,
    onTranscript: () => {},
    onError: (error) => reported.push(error.message)
  })
  return (
    <MobileTerminalInputActions
      canSend
      isAttaching={false}
      dictation={dictation}
      dictationMode="toggle"
      buttonStyle={null}
      activeButtonStyle={null}
      disabledButtonStyle={null}
      onAttachImage={() => {}}
      onAttachFile={() => {}}
      onDictationToggle={() => {
        // The composer's own handler, as `use-mobile-session-native-chat-dictation.ts` writes it: a
        // refused start is a toast, never a throw into render.
        void dictation.start().catch((error: unknown) => {
          reported.push(error instanceof Error ? error.message : String(error))
        })
      }}
      onDictationPressIn={() => {}}
      onDictationPressOut={() => {}}
      onDictationCancel={() => {
        void dictation.cancel()
      }}
    />
  )
}

/** What the desktop answers a forwarded request with; the default is a plain success. */
type DesktopAnswer = (method: string) => {
  id: string
  ok: boolean
  result?: unknown
  error?: unknown
}

const DESKTOP_OK: DesktopAnswer = () => ({ id: 'desktop', ok: true, result: {} })

type MicControl = {
  readonly label: () => string
  readonly tap: (answer?: DesktopAnswer) => Promise<void>
}

/** The mic button, found by the label it carries in every state rather than by position. */
function micOf(root: ReactTestInstance): ReactTestInstance {
  const found = root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.includes('voice dictation')
  )
  const mic = found[0]
  if (found.length !== 1 || mic === undefined) {
    throw new Error(`expected one mic control, found ${found.length}`)
  }
  return mic
}

async function mount(pair: BridgePortPair): Promise<MicControl> {
  await pair.flush()
  const held: { tree: ReturnType<typeof create> | null } = { tree: null }
  await act(async () => {
    held.tree = create(
      <RpcClientProvider client={pair.client}>
        <Composer pair={pair} />
      </RpcClientProvider>
    )
  })
  const rendered = held.tree
  if (rendered === null) {
    throw new Error('nothing mounted')
  }
  return {
    label: () => String(micOf(rendered.root).props.accessibilityLabel),
    tap: async (answer: DesktopAnswer = DESKTOP_OK) => {
      await act(async () => {
        micOf(rendered.root).props.onPress()
      })
      // The tap crosses the bridge, the shell answers, and the desktop answers what was forwarded.
      for (let round = 0; round < 4; round += 1) {
        await act(async () => {
          await pair.flush()
          for (const request of pair.rpc.requests.splice(0)) {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake client takes the reply shape the host would have sent, which is what a case builds here.
            request.resolve(answer(request.method) as never)
          }
          await pair.flush()
        })
      }
    }
  }
}

beforeEach(() => {
  reported.length = 0
  screen.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the mic control on a page the shell did not grant audio', () => {
  it('reports the shell refusal and comes back to its resting label', async () => {
    const pair = createFakeBridgePortPair({
      serveNativeVerb: createAudioShell(),
      routeGrants: ['navigate', 'storage']
    })
    const mic = await mount(pair)
    expect(mic.label()).toBe('Start voice dictation')
    await mic.tap()
    // The refusal is what the composer toasts, naming the verb rather than a blank failure.
    expect(reported).toEqual(['this shell did not grant native.audio.start'])
    // And the control is usable again: a page stuck on "Starting" has no way back to idle.
    expect(mic.label()).toBe('Start voice dictation')
  })

  it('sends no frame for a verb it was never granted', async () => {
    const pair = createFakeBridgePortPair({
      serveNativeVerb: createAudioShell(),
      routeGrants: ['navigate', 'storage']
    })
    const mic = await mount(pair)
    await mic.tap()
    expect(
      pair
        .readToShell()
        .filter((frame) => frame.type === 'request' && frame.method.startsWith('native.audio.'))
    ).toEqual([])
  })
})

describe('a page whose desktop start fails after the microphone opened', () => {
  /**
   * The shell has the microphone open by the time the desktop refuses the session: `open()` is
   * `native.audio.start`, and the page only asks the desktop for a session afterwards. Nothing on
   * that path used to end the capture, so the screen the shell took stayed held until the user
   * cancelled or the screen unmounted.
   */
  it('closes the shell capture and gives the screen back', async () => {
    const shell = createAudioShell()
    const verbs: string[] = []
    const pair = createFakeBridgePortPair({
      serveNativeVerb: (verb, params) => {
        verbs.push(verb)
        return shell(verb, params)
      }
    })
    const mic = await mount(pair)
    await mic.tap((method) =>
      method === 'speech.dictation.start'
        ? { id: 'desktop', ok: false, error: { code: 'refused', message: 'no model installed' } }
        : { id: 'desktop', ok: true, result: {} }
    )
    expect(verbs).toContain('native.audio.start')
    // The microphone is closed and the screen is back, both because the capture ended.
    expect(verbs).toContain('native.audio.stop')
    expect(screen).toEqual(['+', '-'])
    // And the user is told, rather than left looking at a live mic button.
    expect(reported).not.toEqual([])
    expect(mic.label()).toBe('Start voice dictation')
  })
})

describe('the mic control on a page the shell did grant audio', () => {
  it('reaches recording, with no refusal reported', async () => {
    const pair = createFakeBridgePortPair({ serveNativeVerb: createAudioShell() })
    const mic = await mount(pair)
    expect(mic.label()).toBe('Start voice dictation')
    await mic.tap()
    expect(reported).toEqual([])
    expect(mic.label()).toBe('Stop voice dictation')
  })

  it('opens the capture through the shell, and asks it for nothing else', async () => {
    const pair = createFakeBridgePortPair({ serveNativeVerb: createAudioShell() })
    const mic = await mount(pair)
    await mic.tap()
    const verbs = pair
      .readToShell()
      .flatMap((frame) =>
        frame.type === 'request' && frame.method.startsWith('native.') ? [frame.method] : []
      )
    expect(verbs).toContain('native.audio.start')
    // Only the microphone: the screen it holds awake is the device's, and the page has no verb for
    // it to ask through.
    expect(verbs.every((verb) => verb.startsWith('native.audio.'))).toBe(true)
    // And the desktop was told, which is what makes the recording a session rather than a mic.
    expect(
      pair
        .readToShell()
        .some((frame) => frame.type === 'request' && frame.method.startsWith('speech.dictation.'))
    ).toBe(true)
  })
})
