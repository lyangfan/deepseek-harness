// SPEC-05 §10 fixed-reading/navigation and §9.5 recovery, behaviorally: return-stack push/
// pop/restore with the frozen depth cap, reopen non-persistence, viewed-digest pinning with
// the merged new-version notice and explicit switch identity rules, and the focus-triple
// conditional recovery. Wrong implementations that drop stack entries, restore the wrong
// view, replace the pinned list, or restore focus against a moved digest are defeated.
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// jsdom lacks ResizeObserver; polyfill with a no-op for component tests
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const V1 = 'sha256:v1'
const V2 = 'sha256:v2'
const SESSION_ID = 'sess-nav-0001' as never

const card = (id: string) => ({
  candidateId: id,
  subtype: 'conclusion',
  text: `statement ${id}`,
  relationSummary: { summary: 'support_only', activeSupports: 2, activeContradicts: 0, activeQualifies: 0 },
  sourceLabel: 'tool run',
  topBreakpoint: null,
  projectionState: 'active',
})

function graphStatus(currentSnapshotDigest: string | null, pending = 'none') {
  return {
    ok: true,
    status: {
      kind: 'graph',
      graphId: 'eg_nav',
      currentSnapshotDigest,
      headRevision: 1,
      freshness: 'current',
      pending,
      semanticChannel: 'not_configured',
      counts: { candidates: 1, openIssues: 0 },
      versions: { materialStateDigest: 'sha256:m', headRevision: 1, issuesRevision: 'sha256:i' },
    },
  }
}

const onePage = { ok: true, page: { items: [card('cst_1')], total: 1, from: 1, to: 1, nextCursor: null } }

let refreshVersion = 0
const refreshListeners = new Set<() => void>()
const wake = (): void => {
  refreshVersion += 1
  for (const listener of refreshListeners) listener()
}

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
  subscribe: (listener: () => void) => {
    refreshListeners.add(listener)
    return () => { refreshListeners.delete(listener) }
  },
  version: () => refreshVersion,
  recordTokens: () => {},
}

const mockNavigation = {
  activate: vi.fn(),
  subscribe: () => () => {},
  activationFor: () => null,
}

import { EvidenceView } from '../src/client/EvidenceView.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

function renderView(): ReturnType<typeof render> {
  const props = {
    sessionId: SESSION_ID,
    t,
    api: mockApi,
    refresh: mockRefresh,
    navigation: mockNavigation,
    openFile: vi.fn(),
  } as unknown as Parameters<typeof EvidenceView>[0]
  return render(<EvidenceView {...props} />)
}

/** Wait until the candidate list (the pinned body) is actually rendered. */
async function awaitBody(): Promise<void> {
  await screen.findByText(/statement cst_1/)
  await vi.waitFor(() => { expect(mockApi.status).toHaveBeenCalled() })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  refreshVersion = 0
  refreshListeners.clear()
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) {
    mockApi[key].mockResolvedValue({ ok: false, error: { code: 'test', message: 'test' } })
  }
  mockApi.status.mockResolvedValue(graphStatus(V1))
  mockApi.candidates.mockResolvedValue(onePage)
  mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
  mockApi.path.mockResolvedValue({
    ok: true,
    view: {
      center: { ref: { kind: 'CandidateStatement', id: 'cst_1' }, label: 'statement cst_1' },
      groups: [{ direction: 'out', edgeType: 'supported_by', items: [{ ref: { kind: 'Run', id: 'run_1' }, label: 'run_1' }], total: 1 }],
    },
  })
  mockApi.objectDetails.mockResolvedValue({ ok: true, details: { kind: 'ContextEntity', contextKind: 'environment', name: 'env', version: '1' } })
  mockApi.snapshot.mockResolvedValue({ ok: true, header: { snapshotDigest: V2, headRevision: 2 } })
})

afterEach(cleanup)

describe('SPEC-05 §10.3 return stack', () => {
  it('pushes on selection, pops on 返回, and restores the previous view', async () => {
    renderView()
    await awaitBody()
    // No return entry before any navigation.
    expect(screen.queryByText(t('return.back'))).toBeNull()
    fireEvent.click(screen.getByText(/statement cst_1/).closest('button')!)
    await awaitBody()
    expect(screen.getByText(t('return.back'))).not.toBeNull()
    // The selection moved off the list onto the path pane for the chosen candidate.
    expect(mockApi.path).toHaveBeenCalledWith(V1, { kind: 'CandidateStatement', id: 'cst_1' })
    fireEvent.click(screen.getByText(t('return.back')))
    await awaitBody()
    // Popped back to the origin (list pane again, no return entries left).
    expect(screen.queryByText(t('return.back'))).toBeNull()
    expect(screen.getByText(/statement cst_1/)).not.toBeNull()
  })

  it('caps the stack at 10 entries — the 11th origin is dropped, not queued', async () => {
    renderView()
    await awaitBody()
    // Each list→select→back-to-list cycle pushes two entries; six cycles push 12.
    for (let cycle = 0; cycle < 6; cycle += 1) {
      fireEvent.click(screen.getByText(/statement cst_1/).closest('button')!)
      await awaitBody()
      fireEvent.click(screen.getByText(t('path.backToList')))
      await awaitBody()
    }
    // Exactly 10 pops are possible; the two oldest origins were dropped by the cap.
    let pops = 0
    while (screen.queryByText(t('return.back')) !== null && pops < 15) {
      fireEvent.click(screen.getByText(t('return.back')))
      await awaitBody()
      pops += 1
    }
    expect(pops, `pops=${String(pops)} (expected exactly 10)`).toBe(10)
    expect(screen.queryByText(t('return.back'))).toBeNull()
  })

  it('reopen starts from an empty stack (the return stack never persists)', async () => {
    const { unmount } = renderView()
    await awaitBody()
    fireEvent.click(screen.getByText(/statement cst_1/).closest('button')!)
    await awaitBody()
    expect(screen.getByText(t('return.back'))).not.toBeNull()
    unmount()
    renderView()
    await awaitBody()
    expect(screen.queryByText(t('return.back'))).toBeNull()
  })
})

describe('SPEC-05 §10.1 fixed reading (viewedSnapshotDigest pinning)', () => {
  it('keeps reading the pinned digest after the head moves; the notice merges, the list is not replaced', async () => {
    renderView()
    await awaitBody()
    mockApi.candidates.mockClear()
    mockApi.status.mockResolvedValue(graphStatus(V2))
    wake()
    await awaitBody()
    // Viewing stays historical: queries still bind v1, and the merged notice appears once.
    expect(mockApi.candidates).toHaveBeenCalledWith(V1, null, [])
    expect(screen.getByText(new RegExp(t('summary.viewing.historical')))).not.toBeNull()
    expect(screen.getByText(t('notice.newVersion'))).not.toBeNull()
    // The pinned body still renders — the notice never replaces the list.
    expect(screen.getByText(/statement cst_1/)).not.toBeNull()
  })

  it('explicit switch continues identity when the object resolves in the new version', async () => {
    renderView()
    await awaitBody()
    fireEvent.click(screen.getByText(/statement cst_1/).closest('button')!)
    await awaitBody()
    mockApi.status.mockResolvedValue(graphStatus(V2))
    wake()
    await awaitBody()
    mockApi.objectDetails.mockResolvedValue({ ok: true, details: { kind: 'ContextEntity', contextKind: 'environment', name: 'env', version: '2' } })
    fireEvent.click(screen.getByText(t('notice.switch')))
    await awaitBody()
    // §10.1: focus continues by precise identity — the selection survives the switch to v2.
    expect(mockApi.objectDetails).toHaveBeenCalledWith(V2, { kind: 'CandidateStatement', id: 'cst_1' })
    expect(mockApi.path).toHaveBeenCalledWith(V2, { kind: 'CandidateStatement', id: 'cst_1' })
  })

  it('explicit switch falls back to unselected with one neutral notice when identity is missing', async () => {
    renderView()
    await awaitBody()
    fireEvent.click(screen.getByText(/statement cst_1/).closest('button')!)
    await awaitBody()
    mockApi.status.mockResolvedValue(graphStatus(V2))
    wake()
    await awaitBody()
    mockApi.objectDetails.mockResolvedValue({ ok: false, error: { code: 'not_in_snapshot', message: 'missing' } })
    fireEvent.click(screen.getByText(t('notice.switch')))
    await awaitBody()
    expect(screen.getByText(t('notice.focusMissing'))).not.toBeNull()
    // Back on the list pane (selection dropped), still functional.
    expect(screen.getByText(/statement cst_1/)).not.toBeNull()
  })
})

describe('SPEC-05 §9.5 D-140 recovery rule', () => {
  it('restores the persisted focus triple only when its digest is still current and the object resolves', async () => {
    localStorage.setItem(`dsh.evidence.view.v1.${String(SESSION_ID)}`, JSON.stringify({
      schemaVersion: 'dsh.evidence.view/v1',
      subtypes: [],
      focus: { snapshotDigest: V1, objectType: 'CandidateStatement', objectId: 'cst_1' },
    }))
    renderView()
    await awaitBody()
    await vi.waitFor(() => {
      expect(mockApi.objectDetails).toHaveBeenCalledWith(V1, { kind: 'CandidateStatement', id: 'cst_1' })
    })
    // The restored selection drives the path pane for the persisted object.
    await vi.waitFor(() => {
      expect(mockApi.path).toHaveBeenCalledWith(V1, { kind: 'CandidateStatement', id: 'cst_1' })
    })
  })

  it('shows one neutral notice and stays unselected when the persisted digest moved', async () => {
    localStorage.setItem(`dsh.evidence.view.v1.${String(SESSION_ID)}`, JSON.stringify({
      schemaVersion: 'dsh.evidence.view/v1',
      subtypes: [],
      focus: { snapshotDigest: 'sha256:old', objectType: 'CandidateStatement', objectId: 'cst_1' },
    }))
    renderView()
    await awaitBody()
    await vi.waitFor(() => {
      expect(screen.getByText(t('notice.recoverySkipped'))).not.toBeNull()
    })
    expect(mockApi.objectDetails).not.toHaveBeenCalledWith('sha256:old', expect.anything())
  })
})
