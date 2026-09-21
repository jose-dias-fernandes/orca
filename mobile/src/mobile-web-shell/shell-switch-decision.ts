import type { BridgeInitRoute } from './bridge/bridge-init-route'
import { useMobileWebShellEnabled } from './use-mobile-web-shell-enabled'

/**
 * Which renderer a hybrid-shell route switch mounts, once that is knowable.
 *
 * `pending` is the third answer every switch was missing. The flag is read from storage after the
 * first render, so `null` is a window every switch passes through, and each one used to spend it
 * on the native screen: a flag-on user watched the native screen mount, subscribe and paint, then
 * be torn down and replaced by the page. One decision here so a switch cannot hold a private
 * opinion about `null`, and so the flag keeps exactly one reader — which is what makes the census
 * beside this file total rather than a list somebody remembers to extend.
 *
 * A route the shell could never open is answered `native` without waiting: the flag cannot change
 * that outcome, and a neutral frame in front of a decided one is a flash this file exists to remove.
 */
export type ShellSwitchDecision =
  | { readonly kind: 'pending' }
  | { readonly kind: 'native' }
  | { readonly kind: 'shell'; readonly route: BridgeInitRoute }

export function shellSwitchDecision(
  enabled: boolean | null,
  route: BridgeInitRoute | null
): ShellSwitchDecision {
  if (route === null) {
    return { kind: 'native' }
  }
  if (enabled === null) {
    return { kind: 'pending' }
  }
  return enabled ? { kind: 'shell', route } : { kind: 'native' }
}

/** The route is `null` when this switch's params name no screen the shell could open. */
export function useShellSwitchDecision(route: BridgeInitRoute | null): ShellSwitchDecision {
  return shellSwitchDecision(useMobileWebShellEnabled(), route)
}
