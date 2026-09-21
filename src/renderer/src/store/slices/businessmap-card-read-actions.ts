import { businessmapGetCard, businessmapSearchCards } from '@/runtime/runtime-businessmap-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { BusinessmapCard } from '../../../../shared/businessmap-types'
import type {
  BusinessmapSlice,
  BusinessmapSliceGet,
  BusinessmapSliceSet
} from './businessmap-slice-contract'
import {
  canWriteBusinessmapReadResult,
  createBusinessmapAbortError,
  currentBusinessmapMutationGeneration,
  evictStaleBusinessmapCacheEntries,
  getBusinessmapReadScope,
  inflightBusinessmapCardRequests,
  inflightBusinessmapSearchRequests,
  isFreshBusinessmapCacheEntry,
  looksLikeBusinessmapAuthError,
  markBusinessmapConnectionLost,
  scopedBusinessmapCacheKey,
  type InflightBusinessmapReadRequest
} from './businessmap-read-coordination'
import {
  canWriteCollectionResult,
  handleBusinessmapCollectionReadError,
  resolveReadSiteId
} from './businessmap-read-result-guards'

type BusinessmapCardReadActions = Pick<
  BusinessmapSlice,
  'fetchBusinessmapCard' | 'searchBusinessmapCards'
>

export function createBusinessmapCardReadActions(
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet
): BusinessmapCardReadActions {
  return {
    fetchBusinessmapCard: async (id, siteId, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const effectiveSiteId = siteId ?? resolveReadSiteId(options, get)
      const cacheKey = scopedBusinessmapCacheKey(scope, `${effectiveSiteId ?? 'selected'}::${id}`)
      const cached = get().businessmapCardCache[cacheKey] ?? get().businessmapCardCache[String(id)]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data
      }
      const inflight = inflightBusinessmapCardRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === currentBusinessmapMutationGeneration()
      ) {
        return inflight.promise
      }
      let entry: InflightBusinessmapReadRequest<BusinessmapCard | null>
      const requestMutationGeneration = currentBusinessmapMutationGeneration()
      const promise = businessmapGetCard(scope.settings, id, effectiveSiteId)
        .then((card) => {
          if (
            inflightBusinessmapCardRequests.get(cacheKey) === entry &&
            canWriteBusinessmapReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((state) => ({
              businessmapCardCache: evictStaleBusinessmapCacheEntries({
                ...state.businessmapCardCache,
                [cacheKey]: { data: card, fetchedAt: Date.now() }
              })
            }))
          }
          return card
        })
        .catch((error) => {
          console.warn('[businessmap] fetchBusinessmapCard failed:', error)
          if (
            isIntegrationCredentialDecryptionError(error) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            void get().checkBusinessmapConnection()
          } else if (
            looksLikeBusinessmapAuthError(error) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            markBusinessmapConnectionLost(set, scope)
          }
          return null
        })
        .finally(() => {
          if (inflightBusinessmapCardRequests.get(cacheKey) === entry) {
            inflightBusinessmapCardRequests.delete(cacheKey)
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightBusinessmapCardRequests.set(cacheKey, entry)
      return promise
    },

    searchBusinessmapCards: async (query, limit = 30, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const boardId = options?.boardId ?? null
      const cacheKey = scopedBusinessmapCacheKey(
        scope,
        `${siteId ?? 'default'}::${boardId ?? 'all'}::${query}::${limit}`
      )
      const cached = get().businessmapSearchCache[cacheKey]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightBusinessmapSearchRequests.get(cacheKey)
      const abortable = options?.signal !== undefined
      const requestMutationGeneration = currentBusinessmapMutationGeneration()
      if (
        !abortable &&
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration
      ) {
        return inflight.promise
      }
      let entry: InflightBusinessmapReadRequest<BusinessmapCard[]>
      const promise = businessmapSearchCards(
        scope.settings,
        query,
        limit,
        siteId,
        boardId,
        options?.signal
      )
        .then((cards) => {
          if (options?.signal?.aborted) {
            throw createBusinessmapAbortError('search')
          }
          if (
            (abortable || inflightBusinessmapSearchRequests.get(cacheKey) === entry) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            set((state) => ({
              businessmapSearchCache: evictStaleBusinessmapCacheEntries({
                ...state.businessmapSearchCache,
                [cacheKey]: { data: cards, fetchedAt: Date.now() }
              })
            }))
          }
          return cards
        })
        .catch((error) => {
          if (options?.signal?.aborted) {
            throw error
          }
          console.warn('[businessmap] searchBusinessmapCards failed:', error)
          return handleBusinessmapCollectionReadError(
            error,
            scope,
            requestMutationGeneration,
            set,
            get
          )
        })
        .finally(() => {
          if (inflightBusinessmapSearchRequests.get(cacheKey) === entry) {
            inflightBusinessmapSearchRequests.delete(cacheKey)
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      if (!abortable) {
        inflightBusinessmapSearchRequests.set(cacheKey, entry)
      }
      return promise
    }
  }
}
