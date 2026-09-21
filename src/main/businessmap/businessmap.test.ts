import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD_FETCH = globalThis.fetch
const { netFetchMock, resolveProxyMock, setProxyMock, handleMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn(),
  handleMock: vi.fn()
}))

let tempHome = ''
let fetchMock: ReturnType<typeof vi.fn>

function tokenPathForSite(siteId: string): string {
  return join(
    tempHome,
    '.orca',
    'businessmap-tokens',
    `${Buffer.from(siteId).toString('base64url')}.enc`
  )
}

function writeSiteFiles(siteId: string, token: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(join(orcaDir, 'businessmap-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'businessmap-sites.json'),
    JSON.stringify(
      {
        version: 1,
        activeSiteId: siteId,
        selectedSiteId: siteId,
        sites: [{ id: siteId, subdomain: 'acme', domain: 'businessmap.io', displayName: 'Acme' }]
      },
      null,
      2
    ),
    { encoding: 'utf-8' }
  )
  writeFileSync(tokenPathForSite(siteId), token)
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}
// Dynamic imports are intentional: each test needs a fresh module graph
// (credential caches, request queue, rate-limit state) pointed at a temp home.
// oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: merged module bag is test-only; cases access members dynamically.
type BusinessmapTestModule = Record<string, any>

async function loadBusinessmapModule(): Promise<BusinessmapTestModule> {
  vi.resetModules()
  vi.doMock('electron', () => ({
    ipcMain: { handle: handleMock },
    net: { fetch: netFetchMock },
    session: {
      defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock }
    }
  }))
  // oxlint-disable-next-line typescript/no-unsafe-function-type -- SAFETY: mirrors the jira client.test.ts mock; the proxy session stub only needs resolveProxy/setProxy.
  const httpClient = await import('../network/http-client')
  httpClient.setMainHttpClient({
    fetch: (url, init) => netFetchMock(url, init),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mirrors src/main/jira/client.test.ts; the stub only implements the two proxy-session methods the fetch path touches.
    proxySession: () => ({ resolveProxy: resolveProxyMock, setProxy: setProxyMock }) as never
  })
  const secrets = await import('../../shared/secret-store')
  secrets.setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  const [client, queries, mutations, boards, auth, queue, ipc] = await Promise.all([
    import('./client'),
    import('./card-queries'),
    import('./card-mutations'),
    import('./boards'),
    import('./authenticated-request'),
    import('./request-queue'),
    import('../ipc/businessmap')
  ])
  return { ...client, ...queries, ...mutations, ...boards, ...auth, ...queue, ...ipc }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-bm-'))
  fetchMock = vi.fn(async () => {
    throw new Error('fetch should not be called')
  })
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
  globalThis.fetch = fetchMock as typeof fetch
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('Businessmap main backend', () => {
  it('rejects invalid subdomains before any network call', async () => {
    const bm = await loadBusinessmapModule()
    await expect(bm.connect({ subdomain: 'bad_sub!', apiKey: 'key' })).resolves.toMatchObject({
      ok: false
    })
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(() => bm.baseUrl({ id: 'x', subdomain: 'bad_sub!', domain: 'businessmap.io' })).toThrow()
  })

  it('connects via GET /me and reports status', async () => {
    const bm = await loadBusinessmapModule()
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { user_id: 7, realname: 'Ada', email: 'ada@x.io' } })
    )
    await expect(bm.connect({ subdomain: 'acme', apiKey: 'key-1' })).resolves.toMatchObject({
      ok: true,
      viewer: { displayName: 'Ada', subdomain: 'acme' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: netFetchMock records RequestInit; headers is always the Headers instance apiKeyHeaders builds.
    const headers = netFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('apikey')).toBe('key-1')
    expect(netFetchMock.mock.calls[0]?.[0]).toContain('https://acme.businessmap.io/api/v2/me')
    expect(bm.getStatus()).toMatchObject({ connected: true })
  })

  it('lists boards, resolves board trees keyed by id, and caches them', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ board_id: 5, name: 'Eng' }] }))
    await expect(bm.listBoards('site-1')).resolves.toEqual([{ id: 5, name: 'Eng' }])
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'Main' } },
          columns: { 10: { column_id: 10, name: 'Todo', workflow_id: 1 } },
          lanes: { 3: { lane_id: 3, name: 'Fast' } }
        }
      })
    )
    const tree = await bm.getBoardTree(5, 'site-1')
    expect(tree?.columnsById[10]).toMatchObject({ name: 'Todo', workflowId: 1 })
    // Second call hits the 1h cache: no further fetch.
    netFetchMock.mockClear()
    await expect(bm.getBoardTree(5, 'site-1')).resolves.toEqual(tree)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('searches cards across paginated envelopes with board_ids CSV', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          pagination: { current_page: 1, all_pages: 2, results_per_page: 100 },
          data: [
            {
              card_id: 11,
              board_id: 5,
              workflow_id: 1,
              title: 'Fix login',
              column_id: 10,
              owner_user_id: 7,
              last_modified: '2026-09-20T10:00:00Z'
            }
          ]
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          pagination: { current_page: 2, all_pages: 2, results_per_page: 100 },
          data: [
            {
              card_id: 12,
              board_id: 5,
              workflow_id: 1,
              title: 'Fix logout',
              column_id: 10,
              owner_user_id: 7,
              last_modified: '2026-09-21T10:00:00Z'
            }
          ]
        }
      })
    )
    // Name resolution: users + board tree.
    netFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ user_id: 7, realname: 'Ada' }] }))
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'Main' } },
          columns: { 10: { column_id: 10, name: 'Todo', workflow_id: 1 } },
          lanes: {}
        }
      })
    )
    const cards = await bm.searchCards('fix', 30, 'site-1', 5)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({
      boardId: 5,
      title: 'Fix login',
      assignee: { displayName: 'Ada' },
      column: { name: 'Todo' }
    })
    const firstUrl = String(netFetchMock.mock.calls[0]?.[0])
    expect(firstUrl).toContain('board_ids=5')
  })

  it('gets a single card', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          card_id: 11,
          board_id: 5,
          workflow_id: 1,
          title: 'Fix login',
          column_id: 10,
          last_modified: '2026-09-20T10:00:00Z'
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'Main' } },
          columns: { 10: { column_id: 10, name: 'Todo', workflow_id: 1 } },
          lanes: {}
        }
      })
    )
    await expect(bm.getCard(11, 'site-1')).resolves.toMatchObject({ id: 11, title: 'Fix login' })
  })

  it('creates a card with a single POST and never retries 5xx writes', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'Main' } },
          columns: { 10: { column_id: 10, name: 'Todo', workflow_id: 1 } },
          lanes: {}
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const result = await bm.createCard({ boardId: 5, title: 'New card', columnId: 10 }, 'site-1')
    expect(result).toMatchObject({ ok: false })
    const posts = netFetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')
    expect(posts).toHaveLength(1)
  })

  it('moves a card via PATCH with reason and comments via POST', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { card_id: 11, board_id: 5, column_id: 10, lane_id: 3 } })
    )
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'Main' } },
          columns: { 11: { column_id: 11, name: 'Done', workflow_id: 1 } },
          lanes: { 3: { lane_id: 3, name: 'Fast' } }
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(jsonResponse({ data: { card_id: 11 } }))
    await expect(bm.updateCard(11, { columnId: 11, reason: 'done' }, 'site-1')).resolves.toEqual({
      ok: true
    })
    const patch = netFetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
      column_id: 11,
      move_reason: 'done'
    })
    netFetchMock.mockResolvedValueOnce(jsonResponse({ data: { comment_id: 99 } }))
    await expect(bm.addCardComment(11, 'nice', 'site-1')).resolves.toEqual({ ok: true, id: 99 })
    const commentCall = netFetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith('/comments')
    )
    expect(JSON.parse(String(commentCall?.[1]?.body))).toEqual({ text: 'nice' })
  })

  it('rejects ambiguous create on multi-workflow boards without a column', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          workflows: { 1: { workflow_id: 1, name: 'A' }, 2: { workflow_id: 2, name: 'B' } },
          columns: { 10: { column_id: 10, name: 'Todo', workflow_id: 1 } },
          lanes: {}
        }
      })
    )
    const result = await bm.createCard({ boardId: 5, title: 'Ambiguous' }, 'site-1')
    expect(result).toMatchObject({ ok: false })
    expect(netFetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false)
  })

  it('retries reads on RL02 after retry_after but surfaces rate-limit pauses', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'RL02', message: 'slow down', details: { retry_after: 0 } }
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
    netFetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }))
    const entry = bm.getClients('site-1')[0]
    if (!entry) {
      throw new Error('Expected stored Businessmap client')
    }
    // businessmapRead retries the rejected read once and succeeds.
    await expect(bm.businessmapRead(entry, '/boards')).resolves.toBeDefined()
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('throttles new work when the minute quota is nearly spent', async () => {
    const bm = await loadBusinessmapModule()
    writeSiteFiles('site-1', 'token-1')
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [] }, 200, { 'X-RateLimit-Remaining-Minute': '1' })
    )
    await bm.listBoards('site-1')
    // Next acquire pauses ~5s; abort instead of waiting out the throttle.
    const controller = new AbortController()
    const pending = bm.acquire(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('registers every businessmap:* IPC channel', async () => {
    const bm = await loadBusinessmapModule()
    const channels = new Set<string>()
    handleMock.mockReset()
    // oxlint-disable-next-line typescript/no-unsafe-function-type -- SAFETY: test double only records the channel name; the handler itself is never invoked.
    handleMock.mockImplementation(((channel: string) => {
      channels.add(channel)
    }) as never)
    bm.registerBusinessmapHandlers()
    for (const channel of [
      'businessmap:connect',
      'businessmap:disconnect',
      'businessmap:selectSite',
      'businessmap:status',
      'businessmap:readStatus',
      'businessmap:testConnection',
      'businessmap:searchCards',
      'businessmap:listCards',
      'businessmap:getCard',
      'businessmap:createCard',
      'businessmap:updateCard',
      'businessmap:addCardComment',
      'businessmap:issueComments',
      'businessmap:listBoards',
      'businessmap:getBoardTree'
    ]) {
      expect(channels.has(channel)).toBe(true)
    }
  })
})
