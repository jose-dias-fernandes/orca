import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { BusinessmapCard } from '../../../../shared/businessmap-types'
import type { BusinessmapSliceGet, BusinessmapSliceSet } from './businessmap-slice-contract'
import {
  canWriteBusinessmapReadResult,
  getSelectedBusinessmapSiteId,
  looksLikeBusinessmapAuthError,
  markBusinessmapConnectionLost,
  type BusinessmapReadScope
} from './businessmap-read-coordination'

export function canWriteCollectionResult(
  scope: BusinessmapReadScope,
  mutationGeneration: number,
  get: BusinessmapSliceGet
): boolean {
  return canWriteBusinessmapReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource
  )
}

export function handleBusinessmapCollectionReadError(
  error: unknown,
  scope: BusinessmapReadScope,
  mutationGeneration: number,
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet
): BusinessmapCard[] {
  if (
    isIntegrationCredentialDecryptionError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    void get().checkBusinessmapConnection()
  } else if (
    looksLikeBusinessmapAuthError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    markBusinessmapConnectionLost(set, scope)
  }
  if (isIntegrationCredentialDecryptionError(error) || looksLikeBusinessmapAuthError(error)) {
    return []
  }
  throw error
}

export function resolveReadSiteId(
  options: { siteId?: string | null } | undefined,
  get: BusinessmapSliceGet
): string | null {
  if (options && 'siteId' in options && options.siteId !== undefined) {
    return options.siteId
  }
  return getSelectedBusinessmapSiteId(get().businessmapStatus)
}
