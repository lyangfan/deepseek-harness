// SPEC-05 §9 ui-evidence component tests: view tab registration (id/order/locale),
// five-item summary rendering, candidate cards, and empty states.
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'

// jsdom lacks ResizeObserver; polyfill with a no-op for component tests
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the api/refresh inject faces; the component is tested as a pure renderer.
const mockApi = {
  status: vi.fn(),
  snapshot: vi.fn(),
  candidates: vi.fn(),
  path: vi.fn(),
  objectDetails: vi.fn(),
  receipt: vi.fn(),
  issues: vi.fn(),
  navigate: vi.fn(),
  navigateCurrent: vi.fn(),
  preview: vi.fn(),
  openTarget: vi.fn(),
  exportSnapshot: vi.fn(),
  markSeen: vi.fn(),
  processBacklog: vi.fn(),
}

const mockRefresh = {
  subscribe: () => () => {},
  version: () => 0,
  recordTokens: () => {},
}

const mockNavigation = {
  activate: vi.fn(),
  subscribe: () => () => {},
  activationFor: () => null,
}

const mockOpenFile = vi.fn()

// Import after mocks are set up (the component reads injectFace at render time)
import { EvidenceView } from '../src/client/EvidenceView.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

const SESSION_ID = 'sess-e2e-0001' as never

function renderView(overrides: Partial<Parameters<typeof EvidenceView>[0]> = {}): ReturnType<typeof render> {
  const props = {
    sessionId: SESSION_ID,
    t,
    api: mockApi,
    refresh: mockRefresh,
    navigation: mockNavigation,
    openFile: mockOpenFile,
    ...overrides,
  } as unknown as Parameters<typeof EvidenceView>[0]
  return render(<EvidenceView {...props} />)
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  // Default safe returns for every method — prevents unhandled .ok-on-undefined rejections
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) {
    mockApi[key].mockResolvedValue({ ok: false, error: { code: 'test', message: 'test' } })
  }
})

afterEach(cleanup)

describe('SPEC-05 EvidenceView component', () => {
  it('renders the view with data-evidence-session attribute', () => {
    mockApi.status.mockResolvedValue({ ok: true, status: { kind: 'no_graph' } })
    const { container } = renderView()
    const el = container.querySelector('[data-evidence-session]')
    expect(el).not.toBeNull()
  })

  it('shows the no-graph empty state for sessions without a graph', async () => {
    mockApi.status.mockResolvedValue({ ok: true, status: { kind: 'no_graph' } })
    renderView()
    // The summary section renders the empty state text
    await screen.findByText(t('empty.noGraph'), { exact: false })
  })

  it('renders the five-item summary for a graph with a current snapshot', async () => {
    mockApi.status.mockResolvedValue({
      ok: true,
      status: {
        kind: 'graph',
        graphId: 'eg_001',
        currentSnapshotDigest: 'sha256:abc',
        headRevision: 3,
        freshness: 'current',
        pending: 'none',
        semanticChannel: 'not_configured',
        counts: { candidates: 5, openIssues: 2 },
        versions: { materialStateDigest: 'sha256:m', headRevision: 3, issuesRevision: 'sha256:i' },
      },
    })
    mockApi.candidates.mockResolvedValue({
      ok: true,
      page: { items: [], total: 5, from: 0, to: 0, nextCursor: null, versions: { materialStateDigest: 'sha256:m', headRevision: 3, issuesRevision: 'sha256:i' } },
    })
    mockApi.issues.mockResolvedValue({
      ok: true,
      view: { items: [], unread: 0, versions: { materialStateDigest: 'sha256:m', headRevision: 3, issuesRevision: 'sha256:i' } },
    })
    renderView()
    // Five-item summary renders deterministic text
    await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
  })

  // ---- §11.4 three-action separation (A24 unit leg) ----

  function graphStatus(pending: string) {
    return {
      ok: true,
      status: {
        kind: 'graph',
        graphId: 'eg_001',
        currentSnapshotDigest: 'sha256:abc',
        headRevision: 3,
        freshness: 'updating',
        pending,
        semanticChannel: 'not_configured',
        counts: { candidates: 0, openIssues: 0 },
        versions: { materialStateDigest: 'sha256:m', headRevision: 3, issuesRevision: 'sha256:i' },
      },
    }
  }

  it('§11.4-1 refresh re-queries the service and triggers no other verb', async () => {
    mockApi.status.mockResolvedValue(graphStatus('none'))
    mockApi.candidates.mockResolvedValue({ ok: true, page: { items: [], total: 0, from: 0, to: 0, nextCursor: null } })
    mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
    renderView()
    await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
    mockApi.status.mockClear()
    mockApi.processBacklog.mockClear()
    mockApi.exportSnapshot.mockClear()
    screen.getByText(t('action.refresh')).click()
    await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
    expect(mockApi.status.mock.calls.length).toBeGreaterThan(0)
    expect(mockApi.processBacklog).not.toHaveBeenCalled()
    expect(mockApi.exportSnapshot).not.toHaveBeenCalled()
  })

  it('§11.4-2 process calls only the backlog verb and is disabled for none/compiling', async () => {
    mockApi.status.mockResolvedValue(graphStatus('compile_queued'))
    mockApi.candidates.mockResolvedValue({ ok: true, page: { items: [], total: 0, from: 0, to: 0, nextCursor: null } })
    mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
    const { container } = renderView()
    await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
    const process = container.querySelector<HTMLButtonElement>('[data-evidence-action="process"]')
    expect(process).not.toBeNull()
    expect(process!.disabled).toBe(false)
    mockApi.status.mockClear()
    process!.click()
    await vi.waitFor(() => { expect(mockApi.processBacklog).toHaveBeenCalledTimes(1) })
    // Action separation: the process verb chains no re-query and no other verb.
    expect(mockApi.status).not.toHaveBeenCalled()
    expect(mockApi.exportSnapshot).not.toHaveBeenCalled()
  })

  it('§11.4-2 process is enabled for a failed backlog (resume entry) and shows the neutral noop notice when nothing triggers', async () => {
    mockApi.status.mockResolvedValue(graphStatus('failed'))
    mockApi.candidates.mockResolvedValue({ ok: true, page: { items: [], total: 0, from: 0, to: 0, nextCursor: null } })
    mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
    mockApi.processBacklog.mockResolvedValue({ ok: true, outcome: 'paused' })
    const { container } = renderView()
    await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
    const process = container.querySelector<HTMLButtonElement>('[data-evidence-action="process"]')
    expect(process!.disabled).toBe(false)
    process!.click()
    await screen.findByText(t('notice.processNoop'))
  })

  it('§11.4-2 process is disabled while a same-target attempt is active (compiling) and when nothing is queued (none)', async () => {
    for (const pending of ['compiling', 'none'] as const) {
      mockApi.status.mockResolvedValue(graphStatus(pending))
      mockApi.candidates.mockResolvedValue({ ok: true, page: { items: [], total: 0, from: 0, to: 0, nextCursor: null } })
      mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
      const { container } = renderView()
      await screen.findByText(new RegExp(t('summary.viewing.current')), { exact: false })
      const process = container.querySelector<HTMLButtonElement>('[data-evidence-action="process"]')
      expect(process!.disabled, `pending=${pending}`).toBe(true)
      process!.click()
      expect(mockApi.processBacklog).not.toHaveBeenCalled()
      cleanup()
    }
  })
})
