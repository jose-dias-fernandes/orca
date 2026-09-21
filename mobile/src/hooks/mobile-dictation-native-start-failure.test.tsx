/**
 * The native host, when the desktop refuses the session after the microphone is already open.
 *
 * The hook opens the capture first and asks the desktop for a session second, so by the time a
 * refusal comes back the device is holding a microphone and, since ruling 36, the screen with it.
 * Driven through the real native seam rather than a double, because what has to be given back are
 * device calls: this file is the only place the engine and `expo-keep-awake` answer for it.
 */
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'

const device = vi.hoisted(() => ({
  /** Every engine call, in order. */
  calls: new Array<string>(),
  /** The screen, as `+` and `-`: taken when the microphone opens, given back when it closes. */
  screen: new Array<string>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => {
    device.calls.push('initialize')
    return Promise.resolve(true)
  },
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  tearDown: () => device.calls.push('tearDown'),
  toggleRecording: (on: boolean) => {
    device.calls.push(`toggleRecording(${String(on)})`)
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => {
    device.screen.push('+')
    return Promise.resolve()
  },
  deactivateKeepAwake: () => {
    device.screen.push('-')
    return Promise.resolve()
  }
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function mount(client: FakeRpcClient): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript: () => {},
      onError: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
}

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

/** Answers every forwarded request, refusing the one the case names. */
async function pump(rpc: FakeRpcClient, refuse: string): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      request.resolve(
        request.method === refuse
          ? { id: 'desktop', ok: false, error: { code: 'refused', message: 'no model installed' } }
          : { id: 'desktop', ok: true, result: {} }
      )
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

beforeEach(() => {
  device.calls.length = 0
  device.screen.length = 0
  held.dictation = null
})

describe('a native start the desktop refuses', () => {
  it('gives the microphone and the screen back', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await act(async () => {
      // The composer's own handler: a refused start is a toast, never a throw into render.
      const started = dictation()
        .start()
        .catch(() => undefined)
      await pump(rpc, 'speech.dictation.start')
      await started
    })
    // The engine came up before the desktop was asked, so it has to go back down.
    expect(device.calls).toContain('initialize')
    expect(device.calls).toContain('toggleRecording(false)')
    // And the screen with it: nothing else on this path would release it, and the hook's `start`
    // has no catch of its own.
    expect(device.screen).toEqual(['+', '-'])
    expect(dictation().status).toBe('idle')
  })

  it('holds nothing when the refusal comes before the microphone opens', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await act(async () => {
      await dictation().cancel()
    })
    // No start, so no open: the screen was never taken. Read as an absence of holds rather than an
    // empty list, because the lock is one module-level owner shared by both device captures and a
    // release the previous case's cleanup issued would land in this one's list.
    expect(device.screen).not.toContain('+')
    expect(device.calls).not.toContain('initialize')
  })
})
