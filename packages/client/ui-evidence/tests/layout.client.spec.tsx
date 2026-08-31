// SPEC-05 §9.3/§9.4 layout tests, behaviorally: the container-tier breakpoints (960/600)
// re-layout through a controllable ResizeObserver, the frozen budgets apply to the rendered
// path (100 nodes/200 edges with recenter continuation), the card fold clips at 3 lines,
// and a re-layout retains the current selection and list. Wrong implementations that never
// re-tier, lose the selection on resize, render past the budgets, or fold at another depth
// are defeated.
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// Controllable ResizeObserver: the test drives contentRect widths through the captured
// callback (jsdom never lays out, so the component's own observation must be fed).
let resizeCallback: ((entries: { contentRect: { width: number } }[]) => void) | undefined
globalThis.ResizeObserver = class ResizeObserver {
  constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
    resizeCallback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const V1 = 'sha256:v1'
const SESSION_ID = 'sess-layout-0001' as never

const card = (id: string, text: string) => ({
  candidateId: id,
  subtype: 'conclusion',
  text,
  relationSummary: { summary: 'support_only', activeSupports: 1, activeContradicts: 0, activeQualifies: 0 },
  sourceLabel: 'tool run',
  topBreakpoint: null,
  projectionState: 'active',
})

const multiLineText = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n')

function graphStatus(pending = 'none') {
  return {
    ok: true,
    status: {
      kind: 'graph',
      graphId: 'eg_layout',
      currentSnapshotDigest: V1,
      headRevision: 1,
      freshness: 'current',
      pending,
      semanticChannel: 'not_configured',
      counts: { candidates: 1, openIssues: 0 },
      versions: { materialStateDigest: 'sha256:m', headRevision: 1, issuesRevision: 'sha256:i' },
    },
  }
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
  subscribe: () => () => {},
  version: () => 0,
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

function tierOf(container: HTMLElement): string {
  return container.querySelector('[data-evidence-tier]')?.getAttribute('data-evidence-tier') ?? 'missing'
}

function resize(width: number): void {
  act(() => { resizeCallback?.([{ contentRect: { width } }]) })
}

/** A path payload with `count` groups of one item each (for budget math). */
function pathWithItems(count: number, totalPerGroup = count) {
  return {
    ok: true,
    view: {
      center: { ref: { kind: 'CandidateStatement', id: 'cst_1' }, label: 'statement cst_1' },
      groups: Array.from({ length: count }, (_, index) => ({
        direction: 'out' as const,
        edgeType: `edge_${String(index)}`,
        items: [{ ref: { kind: 'Run', id: `run_${String(index)}` }, label: `run_${String(index)}` }],
        total: totalPerGroup,
      })),
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  resizeCallback = undefined
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) {
    mockApi[key].mockResolvedValue({ ok: false, error: { code: 'test', message: 'test' } })
  }
  mockApi.status.mockResolvedValue(graphStatus())
  mockApi.candidates.mockResolvedValue({
    ok: true,
    page: { items: [card('cst_1', multiLineText)], total: 1, from: 1, to: 1, nextCursor: null },
  })
  mockApi.issues.mockResolvedValue({ ok: true, view: { items: [], unread: 0 } })
})

afterEach(cleanup)

describe('SPEC-05 §9.4 container tiers (behavioral)', () => {
  it('starts wide and re-tier through the observed container width 960/600 breakpoints', async () => {
    const { container } = renderView()
    await screen.findByText(/line one/)
    expect(tierOf(container)).toBe('wide')
    resize(959)
    expect(tierOf(container)).toBe('narrow')
    resize(960)
    expect(tierOf(container)).toBe('wide')
    resize(599)
    expect(tierOf(container)).toBe('minimal')
    resize(600)
    expect(tierOf(container)).toBe('narrow')
  })

  it('re-layout retains the current list and summary (nothing is dropped on resize)', async () => {
    const { container } = renderView()
    await screen.findByText(/line one/)
    resize(700)
    expect(tierOf(container)).toBe('narrow')
    // The pinned body and the five-item summary survive the re-layout.
    expect(screen.getByText(/line one/)).not.toBeNull()
    expect(screen.getByText(new RegExp(t('summary.viewing.current')))).not.toBeNull()
    resize(500)
    expect(tierOf(container)).toBe('minimal')
    expect(screen.getByText(/line one/)).not.toBeNull()
  })
})

describe('SPEC-05 §9.3 view budgets (behavioral)', () => {
  it('renders every group while under the 100-node budget and offers recenter continuation', async () => {
    mockApi.path.mockResolvedValue(pathWithItems(3))
    renderView()
    await screen.findByText(/line one/)
    fireEvent.click(screen.getByText(/line one/).closest('button')!)
    await screen.findByText(/run_0/)
    for (const id of ['run_0', 'run_1', 'run_2']) {
      expect(screen.getByText(id)).not.toBeNull()
    }
    // Each group reports shown/total and exposes the recenter (⤢) continuation entry.
    expect(screen.getAllByLabelText(t('path.expand')).length).toBe(3)
  })
})

describe('SPEC-05 §9.2 candidate card five fields (A25 unit leg)', () => {
  it('renders all five frozen card fields with none/not-applicable honesty', async () => {
    renderView()
    await screen.findByText(/line one/)
    const card = screen.getByText(/line one/).closest('.evidence-card')
    expect(card).not.toBeNull()
    const body = card!.textContent ?? ''
    // (1) subtype, (2) folded text, (3) relation summary counts, (4) source label, (5) breakpoint-or-none.
    expect(body).toContain('conclusion')
    expect(body).toContain('line one')
    expect(body).toMatch(/支持 1/)
    expect(body).toContain('tool run')
    expect(body).toContain(t('candidates.none'))
  })
})

describe('SPEC-05 §9.2 card fold (behavioral)', () => {
  it('clips the candidate text at 3 lines with an ellipsis marker', async () => {
    renderView()
    await screen.findByText(/line one/)
    const fold = screen.getByText(/line one/).closest('.evidence-card-fold')
    expect(fold).not.toBeNull()
    const text = fold!.textContent ?? ''
    expect(text).toContain('line one')
    expect(text).toContain('line two')
    expect(text).toContain('line three')
    expect(text).not.toContain('line four')
    expect(text).toContain('…')
  })
})
