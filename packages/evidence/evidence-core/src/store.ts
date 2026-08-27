/** Private single-writer owner for the `animalge_evidence` Storage Domain. */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { canonicalJson, sha256Digest } from './canonical-json.ts'
import { newCompileAttemptId, newEvidenceGraphId, newRecoveryId, newStagingId } from './identity.ts'
import {
  capturedInvocationSchema,
  compileAttemptSchema,
  compileOutboxSchema,
  currentHeadSchema,
  graphRecordSchema,
  headCommitSchema,
  quarantineRecordSchema,
  queueClockSchema,
  sessionGraphBootstrapSchema,
  stagingRecordSchema,
  storedSnapshotSchema,
  usageSchema,
} from './schema.ts'
import type { CapturedInvocation, CompileAttempt, CompileOutbox, GraphRecord, HeadCommit, QuarantineRecord, QueueClock, SessionGraphBootstrap, StagingRecord, UsageRecord } from './schema.ts'
import type { CompileAttemptId, CurrentHeadV1, EvidenceGraphId, EvidenceGraphScopeV1, EvidenceSnapshotPayloadV1, RecoveryId, Sha256Digest, StagingId, StoredSnapshotV1 } from './types.ts'
import { snapshotRecord, verifyStoredSnapshot } from './integrity.ts'

type CommitKey = `${string}:${number}`

/** Durable declaration shared by both JSON and SQLite Storage backends. */
export const evidenceDomainSpec = defineDomain({
  name: 'animalge_evidence',
  version: 0,
  tables: {
    graphs: domainTable<EvidenceGraphId, GraphRecord>(graphRecordSchema),
    session_graphs: domainTable<SessionId, SessionGraphBootstrap>(sessionGraphBootstrapSchema),
    captures: domainTable<string, CapturedInvocation>(capturedInvocationSchema),
    snapshots: domainTable<Sha256Digest, StoredSnapshotV1>(storedSnapshotSchema),
    heads: domainTable<EvidenceGraphId, CurrentHeadV1>(currentHeadSchema),
    head_commits: domainTable<CommitKey, HeadCommit>(headCommitSchema),
    attempts: domainTable<CompileAttemptId, CompileAttempt>(compileAttemptSchema),
    outbox: domainTable<EvidenceGraphId, CompileOutbox>(compileOutboxSchema),
    staging: domainTable<StagingId, StagingRecord>(stagingRecordSchema),
    quarantine: domainTable<RecoveryId, QuarantineRecord>(quarantineRecordSchema),
    queue_clock: domainTable<'global', QueueClock>(queueClockSchema),
    usage: domainTable<'global', UsageRecord>(usageSchema),
  },
})

export class EvidenceStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EvidenceStoreError'
  }
}

function sameBytes(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
}

function headAt(graphId: EvidenceGraphId, revision = 0): CurrentHeadV1 {
  return {
    recordVersion: 'animalge.current-head/v1',
    graphId,
    snapshotDigest: null,
    headRevision: revision,
    previousSnapshotDigest: null,
    previousHeadRevision: null,
  }
}

/** Private owner; no Context service or public registry is installed. */
export class EvidenceStore {
  private tail: Promise<void> = Promise.resolve()
  private accepting = true

  private constructor(private readonly domain: Domain<typeof evidenceDomainSpec>) {}

  static async open(ctx: Context): Promise<EvidenceStore> {
    const domain = await ctx.storageDomain.open(evidenceDomainSpec)
    const owner = new EvidenceStore(domain)
    await owner.initializeControlRows()
    return owner
  }

  get graphs(): KvTable<EvidenceGraphId, GraphRecord> { return this.domain.table('graphs') }
  get sessionGraphs(): KvTable<SessionId, SessionGraphBootstrap> { return this.domain.table('session_graphs') }
  get captures(): KvTable<string, CapturedInvocation> { return this.domain.table('captures') }
  get snapshots(): KvTable<Sha256Digest, StoredSnapshotV1> { return this.domain.table('snapshots') }
  get heads(): KvTable<EvidenceGraphId, CurrentHeadV1> { return this.domain.table('heads') }
  get headCommits(): KvTable<CommitKey, HeadCommit> { return this.domain.table('head_commits') }
  get attempts(): KvTable<CompileAttemptId, CompileAttempt> { return this.domain.table('attempts') }
  get outbox(): KvTable<EvidenceGraphId, CompileOutbox> { return this.domain.table('outbox') }
  get staging(): KvTable<StagingId, StagingRecord> { return this.domain.table('staging') }
  get quarantine(): KvTable<RecoveryId, QuarantineRecord> { return this.domain.table('quarantine') }
  get queueClock(): KvTable<'global', QueueClock> { return this.domain.table('queue_clock') }
  get usage(): KvTable<'global', UsageRecord> { return this.domain.table('usage') }

  async close(): Promise<void> {
    this.accepting = false
    await this.tail
    await this.domain.close()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new EvidenceStoreError('closed', 'Evidence Store is closed'))
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async initializeControlRows(): Promise<void> {
    await this.enqueue(async () => {
      if (this.queueClock.get('global') === undefined) {
        if (this.outbox.size > 0 || this.attempts.size > 0) throw new EvidenceStoreError('queue_clock_corrupt', 'queue clock missing with durable queue state')
        await this.queueClock.put('global', { recordVersion: 'animalge.queue-clock/v1', nextTicket: 1 })
      }
      const clock = this.queueClock.get('global') as QueueClock
      const maximum = Math.max(0, ...[...this.outbox.entries()].map(([, row]) => row.fairTicket))
      if (clock.nextTicket <= maximum) throw new EvidenceStoreError('queue_clock_corrupt', 'queue clock does not exceed durable tickets')
      if (this.usage.get('global') === undefined) {
        await this.usage.put('global', { recordVersion: 'animalge.usage/v1', accountedBytes: 0, recordCount: 0, recountedAt: Date.now() })
      }
      await this.recountNow()
    })
  }

  private async putImmutable<K extends string, V>(table: KvTable<K, V>, key: K, value: V): Promise<void> {
    const current = table.get(key)
    if (current === undefined) {
      await table.put(key, value)
      return
    }
    if (!sameBytes(current, value)) throw new EvidenceStoreError('immutable_key_collision', `immutable key '${key}' has different bytes`)
  }

  async bootstrap(header: SessionHeader, workspaceId?: WorkspaceId): Promise<EvidenceGraphScopeV1> {
    return this.enqueue(async () => {
      const existing = this.sessionGraphs.get(header.id)
      let intent: SessionGraphBootstrap
      if (existing === undefined) {
        const graphId = newEvidenceGraphId()
        const initialScope: EvidenceGraphScopeV1 = {
          kind: 'session', graphId, sessionId: header.id, sessionCreatedAt: header.createdAt,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        }
        intent = {
          recordVersion: 'animalge.session-graph-bootstrap/v1',
          sessionId: header.id,
          sessionCreatedAt: header.createdAt,
          graphId,
          initialScope,
          state: 'initializing',
        }
        await this.sessionGraphs.put(header.id, intent)
      } else {
        intent = existing
        if (intent.sessionCreatedAt !== header.createdAt || intent.sessionId !== header.id) {
          throw new EvidenceStoreError('session_lifecycle_conflict', `session '${header.id}' lifecycle conflicts with its Graph mapping`)
        }
        if (intent.state === 'ready') {
          // §7.2: a ready mapping must already own matching companions; a missing or
          // mismatched one is bootstrap corruption, never something to self-heal.
          const readyGraph = this.graphs.get(intent.graphId)
          const readyHead = this.heads.get(intent.graphId)
          if (readyGraph === undefined || readyHead === undefined || readyHead.graphId !== intent.graphId) {
            throw new EvidenceStoreError('bootstrap_corrupt', `Graph '${intent.graphId}' lacks matching companions`)
          }
        }
      }
      const graph: GraphRecord = { recordVersion: 'animalge.evidence-graph/v1', scope: intent.initialScope, status: 'ready' }
      if (this.graphs.get(intent.graphId) === undefined) await this.putImmutable(this.graphs, intent.graphId, graph)
      await this.putImmutable(this.heads, intent.graphId, headAt(intent.graphId))
      if (intent.state === 'initializing') {
        intent = await this.sessionGraphs.update(header.id, (current) => {
          if (!sameBytes(current, intent)) throw new EvidenceStoreError('bootstrap_mapping_conflict', `session '${header.id}' bootstrap intent changed`)
          return { ...current, state: 'ready' }
        })
      }
      let companionGraph = this.graphs.get(intent.graphId)
      const companionHead = this.heads.get(intent.graphId)
      if (companionGraph === undefined || companionHead === undefined || companionHead.graphId !== intent.graphId) {
        throw new EvidenceStoreError('bootstrap_corrupt', `Graph '${intent.graphId}' lacks matching companions`)
      }
      if (workspaceId !== undefined) {
        if (companionGraph.scope.workspaceId !== undefined && companionGraph.scope.workspaceId !== workspaceId) {
          throw new EvidenceStoreError('scope_workspace_conflict', `Graph '${intent.graphId}' is already bound to another Workspace`)
        }
        if (companionGraph.scope.workspaceId === undefined) {
          companionGraph = await this.graphs.update(intent.graphId, current => ({ ...current, scope: { ...current.scope, workspaceId } }))
        }
      }
      await this.recountNow()
      return companionGraph.scope
    })
  }

  async recoverBootstraps(): Promise<void> {
    const rows = [...this.sessionGraphs.entries()]
    for (const [, row] of rows) {
      if (row.state === 'initializing') {
        await this.bootstrap({ version: 0, id: row.sessionId, createdAt: row.sessionCreatedAt })
      } else if (this.graphs.get(row.graphId) === undefined || this.heads.get(row.graphId) === undefined) {
        await this.enqueue(async () => {
          const graph = this.graphs.get(row.graphId)
          if (graph !== undefined) await this.graphs.put(row.graphId, { ...graph, status: 'bootstrap_corrupt' })
          await this.quarantineNow(row.graphId, 'session_graphs', row.sessionId, 'bootstrap_corrupt', 'startup', [])
        })
      }
    }
  }

  async saveCapture(capture: CapturedInvocation): Promise<void> {
    await this.enqueue(async () => {
      const current = this.captures.get(capture.runId)
      if (current !== undefined) {
        const { selection: _currentSelection, selectionRuleDigest: _currentRule, ...currentExecution } = current
        const { selection: _nextSelection, selectionRuleDigest: _nextRule, ...nextExecution } = capture
        if (!sameBytes(currentExecution, nextExecution)) {
          throw new EvidenceStoreError('capture_identity_conflict', `capture '${capture.runId}' changed immutable execution bytes`)
        }
        if (!sameBytes(current, capture)) await this.captures.put(capture.runId, capture)
      }
      if (current === undefined) await this.captures.put(capture.runId, capture)
      await this.recountNow()
    })
  }

  capturesFor(graphId: EvidenceGraphId): CapturedInvocation[] {
    return [...this.captures.entries()].map(([, row]) => row).filter(row => row.graphId === graphId)
  }

  async admitOutbox(row: Omit<CompileOutbox, 'fairTicket' | 'recordVersion' | 'inFlightAttemptId'>): Promise<CompileOutbox> {
    return this.enqueue(async () => {
      const existing = this.outbox.get(row.graphId)
      if (existing !== undefined) {
        if (existing.sessionId !== row.sessionId) throw new EvidenceStoreError('queue_link_corrupt', 'outbox Session identity changed')
        const merged: CompileOutbox = {
          ...existing,
          targetNextSeqExclusive: Math.max(existing.targetNextSeqExclusive, row.targetNextSeqExclusive),
          lastBoundarySeq: Math.max(existing.lastBoundarySeq, row.lastBoundarySeq),
          boundaryCount: existing.boundaryCount + row.boundaryCount,
          reasonCounts: Object.fromEntries(Object.keys(existing.reasonCounts).map(key => [key, existing.reasonCounts[key as keyof typeof existing.reasonCounts] + row.reasonCounts[key as keyof typeof row.reasonCounts]])) as CompileOutbox['reasonCounts'],
          lastQueuedAt: row.lastQueuedAt,
          eligibleAfter: row.eligibleAfter,
          latestAdmittedTarget: Math.max(existing.latestAdmittedTarget ?? 0, row.latestAdmittedTarget ?? row.targetNextSeqExclusive),
          // §8.1: once a row has overflowed (or this admission overflows it), the marker and the
          // first rejected target survive every merge so the row stays paused at its watermark.
          overflowed: existing.overflowed || row.overflowed,
          ...(existing.firstRejectedTarget === undefined && row.firstRejectedTarget === undefined
            ? {}
            : { firstRejectedTarget: existing.firstRejectedTarget ?? row.firstRejectedTarget }),
        }
        await this.outbox.put(row.graphId, merged)
        await this.recountNow()
        return merged
      }
      const fairTicket = await this.nextTicketNow()
      const created: CompileOutbox = { ...row, recordVersion: 'animalge.compile-outbox/v1', fairTicket, inFlightAttemptId: null }
      await this.outbox.put(row.graphId, created)
      await this.recountNow()
      return created
    })
  }

  private async nextTicketNow(): Promise<number> {
    const clock = await this.queueClock.update('global', (current) => {
      if (current.nextTicket >= Number.MAX_SAFE_INTEGER) throw new EvidenceStoreError('queue_ticket_exhausted', 'queue ticket exhausted')
      return { ...current, nextTicket: current.nextTicket + 1 }
    })
    return clock.nextTicket - 1
  }

  runnableOutbox(now: number): CompileOutbox | undefined {
    return [...this.outbox.entries()].map(([, row]) => row)
      .filter((row) => {
        if (row.eligibleAfter > now || row.retryNotBefore > now || row.overflowed) return false
        if (row.inFlightAttemptId === null) return true
        return this.attempts.get(row.inFlightAttemptId)?.state === 'queued'
      })
      .sort((left, right) => left.fairTicket - right.fairTicket || left.graphId.localeCompare(right.graphId))[0]
  }

  nextRunnableAt(): number | undefined {
    const values = [...this.outbox.entries()].map(([, row]) => row)
      .filter(row => !row.overflowed && (row.inFlightAttemptId === null || this.attempts.get(row.inFlightAttemptId)?.state === 'queued'))
      .map(row => Math.max(row.eligibleAfter, row.retryNotBefore))
      .filter(value => value < Number.MAX_SAFE_INTEGER)
    return values.length === 0 ? undefined : Math.min(...values)
  }

  async dequeue(row: CompileOutbox, head: CurrentHeadV1, revisions: EvidenceSnapshotPayloadV1['revisions']): Promise<CompileAttempt> {
    return this.enqueue(async () => {
      if (row.inFlightAttemptId !== null) {
        const queued = this.attempts.get(row.inFlightAttemptId)
        if (queued === undefined || queued.state !== 'queued' || queued.graphId !== row.graphId
          || queued.sessionId !== row.sessionId
          || queued.targetNextSeqExclusive !== row.targetNextSeqExclusive
          || queued.baseSnapshotDigest !== head.snapshotDigest
          || queued.baseHeadRevision !== head.headRevision
          || !sameBytes(queued.revisions, revisions)) {
          throw new EvidenceStoreError('queue_link_corrupt', 'queued attempt does not match its durable outbox')
        }
        return queued
      }
      const attemptId = newCompileAttemptId()
      const now = Date.now()
      const retryOf = [...this.attempts.entries()].map(([, candidate]) => candidate)
        .filter(candidate => candidate.graphId === row.graphId && candidate.targetNextSeqExclusive === row.targetNextSeqExclusive
          && ['failed', 'interrupted', 'cancelled'].includes(candidate.state))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.attemptId ?? null
      const attempt: CompileAttempt = {
        recordVersion: 'animalge.compile-attempt/v1', attemptId, graphId: row.graphId, sessionId: row.sessionId,
        fromNextSeqExclusive: this.snapshotWatermark(head.snapshotDigest), targetNextSeqExclusive: row.targetNextSeqExclusive,
        baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision, state: 'queued', stage: 'capture', revisions,
        retryOf, startedAt: null, updatedAt: now, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }
      await this.putImmutable(this.attempts, attemptId, attempt)
      await this.outbox.update(row.graphId, (current) => {
        if (current.fairTicket !== row.fairTicket
          || current.targetNextSeqExclusive !== row.targetNextSeqExclusive
          || current.inFlightAttemptId !== null) {
          throw new EvidenceStoreError('queue_link_corrupt', 'outbox changed before dequeue linearization')
        }
        return { ...current, inFlightAttemptId: attemptId }
      })
      return attempt
    })
  }

  async startAttempt(attemptId: CompileAttemptId): Promise<CompileAttempt> {
    return this.enqueue(() => this.attempts.update(attemptId, current => ({ ...current, state: 'running', startedAt: Date.now(), updatedAt: Date.now() })))
  }

  async commit(attempt: CompileAttempt, payload: EvidenceSnapshotPayloadV1, kind: 'compile' | 'recovery' = 'compile'): Promise<CurrentHeadV1> {
    return this.enqueue(async () => {
      const currentHeadRow = this.heads.get(attempt.graphId)
      if (currentHeadRow !== undefined && currentHeadRow.snapshotDigest !== null) {
        let coveredPayload: ReturnType<typeof verifyStoredSnapshot> | undefined
        try {
          coveredPayload = verifyStoredSnapshot(this.committedSnapshot(currentHeadRow.snapshotDigest))
        } catch { coveredPayload = undefined }
        if (coveredPayload !== undefined
          && coveredPayload.deterministicWatermark.nextSeqExclusive >= payload.deterministicWatermark.nextSeqExclusive
          && sameBytes(coveredPayload.revisions, payload.revisions)) {
          // §8.4 covered-target no-op: identical revisions already cover the target; settle the
          // duplicate request as succeeded without creating a new Snapshot or head revision.
          await this.attempts.put(attempt.attemptId, {
            ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(),
            resultSnapshotDigest: currentHeadRow.snapshotDigest,
          })
          await this.settleCoveredOutbox(attempt)
          await this.recountNow()
          return currentHeadRow
        }
      }
      const record = snapshotRecord(payload)
      const stagingId = newStagingId()
      const stage: StagingRecord = {
        recordVersion: 'animalge.staging/v1', stagingId, attemptId: attempt.attemptId, graphId: attempt.graphId,
        expectedSnapshotDigest: attempt.baseSnapshotDigest, expectedHeadRevision: attempt.baseHeadRevision,
        candidateSnapshotDigest: record.snapshotDigest, createdAt: Date.now(), state: 'validated',
      }
      await this.putImmutable(this.staging, stagingId, stage)
      try {
        await this.putImmutable(this.snapshots, record.snapshotDigest, record)
      } catch (error) {
        if (error instanceof EvidenceStoreError && error.code === 'immutable_key_collision') {
          await this.quarantineNow(attempt.graphId, 'snapshots', record.snapshotDigest, 'immutable_key_collision', 'commit', [])
        }
        throw error
      }
      await this.attempts.put(attempt.attemptId, {
        ...attempt, stage: 'commit', updatedAt: Date.now(), stagingId, resultSnapshotDigest: record.snapshotDigest,
      })
      const head = await this.heads.update(attempt.graphId, (current) => {
        if (current.snapshotDigest !== attempt.baseSnapshotDigest || current.headRevision !== attempt.baseHeadRevision) {
          throw new EvidenceStoreError('head_cas_conflict', `expected head ${String(attempt.baseSnapshotDigest)}@${attempt.baseHeadRevision}, got ${String(current.snapshotDigest)}@${current.headRevision}`)
        }
        return {
          recordVersion: 'animalge.current-head/v1', graphId: attempt.graphId,
          snapshotDigest: record.snapshotDigest, headRevision: current.headRevision + 1,
          previousSnapshotDigest: current.snapshotDigest, previousHeadRevision: current.headRevision,
        }
      })
      try {
        await this.finalizeCommit(attempt, head, record, stagingId, stage, kind)
      } catch {
        // §7.4(6): the durable head update above is the commit point, so the Snapshot is
        // already committed; repair the history and settle as succeeded instead of failing.
        try {
          await this.repairMissingHeadCommit(attempt.graphId, head)
          await this.settleCoveredOutbox(attempt)
        } catch {
          const pending = this.attempts.get(attempt.attemptId) ?? attempt
          await this.attempts.put(attempt.attemptId, {
            ...pending, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(),
            resultSnapshotDigest: record.snapshotDigest,
          }).catch(() => {})
          throw new EvidenceStoreError('post_commit_repair_pending', `head '${String(head.snapshotDigest)}'@${head.headRevision} is committed but its history repair is pending`)
        }
        return head
      }
      await this.recountNow()
      return head
    })
  }

  private async finalizeCommit(
    attempt: CompileAttempt,
    head: CurrentHeadV1,
    record: StoredSnapshotV1,
    stagingId: StagingId,
    stage: StagingRecord,
    kind: 'compile' | 'recovery',
  ): Promise<void> {
    const commit: HeadCommit = {
      recordVersion: 'animalge.head-commit/v1', graphId: attempt.graphId, headRevision: head.headRevision,
      previousSnapshotDigest: head.previousSnapshotDigest, snapshotDigest: head.snapshotDigest,
      kind, operationId: attempt.attemptId, committedAt: Date.now(),
    }
    await this.putImmutable(this.headCommits, `${attempt.graphId}:${head.headRevision}`, commit)
    await this.staging.put(stagingId, { ...stage, state: 'committed' })
    await this.attempts.put(attempt.attemptId, { ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(), stagingId, resultSnapshotDigest: record.snapshotDigest })
    await this.settleCoveredOutbox(attempt)
  }

  private async settleCoveredOutbox(attempt: CompileAttempt): Promise<void> {
    const outbox = this.outbox.get(attempt.graphId)
    if (outbox !== undefined && outbox.inFlightAttemptId === attempt.attemptId) {
      if (outbox.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(attempt.graphId)
      else await this.outbox.put(attempt.graphId, { ...outbox, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
    }
  }

  attemptOrdinal(attempt: CompileAttempt): number {
    let ordinal = 1
    let previous = attempt.retryOf
    const seen = new Set<CompileAttemptId>()
    while (previous !== null) {
      if (seen.has(previous)) throw new EvidenceStoreError('attempt_chain_corrupt', 'retryOf chain contains a cycle')
      seen.add(previous)
      const record = this.attempts.get(previous)
      if (record === undefined) throw new EvidenceStoreError('attempt_chain_corrupt', `retry predecessor '${previous}' is missing`)
      ordinal++
      previous = record.retryOf
    }
    return ordinal
  }

  async failAttempt(attempt: CompileAttempt, code: string, retryable: boolean, retryDelayMs?: number): Promise<void> {
    await this.enqueue(async () => {
      const current = this.attempts.get(attempt.attemptId) ?? attempt
      await this.attempts.put(attempt.attemptId, {
        ...current, state: 'failed', updatedAt: Date.now(),
        terminalError: { code, stage: current.stage, retryable, messageDigest: sha256Digest(code) },
      })
      const row = this.outbox.get(attempt.graphId)
      if (row?.inFlightAttemptId === attempt.attemptId) {
        const willRetry = retryable && retryDelayMs !== undefined
        await this.outbox.put(attempt.graphId, {
          ...row,
          inFlightAttemptId: null,
          fairTicket: await this.nextTicketNow(),
          retryNotBefore: willRetry ? Date.now() + retryDelayMs : Number.MAX_SAFE_INTEGER,
          reasonCounts: { ...row.reasonCounts, retry: row.reasonCounts.retry + (willRetry ? 1 : 0) },
        })
      }
      await this.recountNow()
    })
  }

  async cancelAttempt(attempt: CompileAttempt): Promise<void> {
    await this.enqueue(async () => {
      const current = this.attempts.get(attempt.attemptId) ?? attempt
      if (current.state === 'succeeded') return
      await this.attempts.put(attempt.attemptId, {
        ...current, state: 'cancelled', updatedAt: Date.now(),
        terminalError: { code: 'cancelled', stage: current.stage, retryable: false, messageDigest: sha256Digest('cancelled') },
      })
      const row = this.outbox.get(attempt.graphId)
      if (row?.inFlightAttemptId === attempt.attemptId) await this.outbox.put(attempt.graphId, { ...row, inFlightAttemptId: null })
      await this.recountNow()
    })
  }

  async recoverHead(
    graphId: EvidenceGraphId,
    expected: CurrentHeadV1,
    restoredDigest: Sha256Digest | null,
    quarantinedDigest: Sha256Digest | null,
  ): Promise<CurrentHeadV1> {
    return this.enqueue(async () => {
      if (restoredDigest !== null) verifyStoredSnapshot(this.snapshots.get(restoredDigest) ?? (() => { throw new EvidenceStoreError('snapshot_missing', `recovery Snapshot '${restoredDigest}' is missing`) })())
      const recoveryId = newRecoveryId()
      const next = await this.heads.update(graphId, (current) => {
        if (current.snapshotDigest !== expected.snapshotDigest || current.headRevision !== expected.headRevision) throw new EvidenceStoreError('head_cas_conflict', 'head changed during recovery')
        return {
          recordVersion: 'animalge.current-head/v1', graphId, snapshotDigest: restoredDigest,
          headRevision: current.headRevision + 1,
          previousSnapshotDigest: current.snapshotDigest,
          previousHeadRevision: current.headRevision,
        }
      })
      await this.putImmutable(this.headCommits, `${graphId}:${next.headRevision}`, {
        recordVersion: 'animalge.head-commit/v1', graphId, headRevision: next.headRevision,
        previousSnapshotDigest: quarantinedDigest, snapshotDigest: restoredDigest, kind: 'recovery', operationId: recoveryId, committedAt: Date.now(),
      })
      const graph = this.graphs.get(graphId)
      if (graph !== undefined && restoredDigest === null) await this.graphs.put(graphId, { ...graph, status: 'unavailable' })
      await this.recountNow()
      return next
    })
  }

  async repairMissingHeadCommit(graphId: EvidenceGraphId, head: CurrentHeadV1): Promise<void> {
    await this.enqueue(async () => {
      const key = `${graphId}:${head.headRevision}` as CommitKey
      if (this.headCommits.get(key) !== undefined || head.snapshotDigest === null) return
      const matching = [...this.staging.entries()].map(([, row]) => row).filter(row => row.graphId === graphId
        && row.candidateSnapshotDigest === head.snapshotDigest && row.expectedSnapshotDigest === head.previousSnapshotDigest
        && row.expectedHeadRevision + 1 === head.headRevision)
      const stage = matching.length === 1 ? matching[0] : undefined
      const operationId = stage?.attemptId ?? newRecoveryId()
      await this.putImmutable(this.headCommits, key, {
        recordVersion: 'animalge.head-commit/v1', graphId, headRevision: head.headRevision,
        previousSnapshotDigest: head.previousSnapshotDigest, snapshotDigest: head.snapshotDigest,
        kind: stage === undefined ? 'recovery' : 'compile', operationId, committedAt: Date.now(),
      })
      if (stage !== undefined) {
        await this.staging.put(stage.stagingId, { ...stage, state: 'committed' })
        const attempt = this.attempts.get(stage.attemptId)
        if (attempt !== undefined) {
          await this.attempts.put(stage.attemptId, {
            ...attempt,
            state: 'succeeded',
            stage: 'finalize',
            updatedAt: Date.now(),
            stagingId: stage.stagingId,
            resultSnapshotDigest: head.snapshotDigest,
          })
        }
      }
      await this.recountNow()
    })
  }

  async reconcileAttempts(): Promise<void> {
    await this.enqueue(async () => {
      for (const [graphId, row] of this.outbox.entries()) {
        if (row.inFlightAttemptId === null) continue
        const attempt = this.attempts.get(row.inFlightAttemptId)
        if (attempt === undefined || attempt.graphId !== graphId || attempt.sessionId !== row.sessionId
          || attempt.targetNextSeqExclusive !== row.targetNextSeqExclusive) {
          await this.quarantineNow(graphId, 'outbox', graphId, 'queue_link_corrupt', 'startup', [row.inFlightAttemptId])
          await this.outbox.put(graphId, { ...row, overflowed: true })
          continue
        }
        if (attempt.state === 'running') {
          const stage = attempt.stagingId === null ? undefined : this.staging.get(attempt.stagingId)
          const head = this.heads.get(attempt.graphId)
          const committed = attempt.resultSnapshotDigest !== null && head?.snapshotDigest === attempt.resultSnapshotDigest
            && (this.headCommits.get(`${attempt.graphId}:${head.headRevision}`) !== undefined || stage?.candidateSnapshotDigest === head.snapshotDigest)
          if (committed) {
            await this.attempts.put(attempt.attemptId, { ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now() })
            if (stage !== undefined) await this.staging.put(stage.stagingId, { ...stage, state: 'committed' })
            if (row.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(graphId)
            else await this.outbox.put(graphId, { ...row, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
          } else {
            await this.attempts.put(attempt.attemptId, { ...attempt, state: 'interrupted', updatedAt: Date.now() })
            await this.outbox.put(graphId, {
              ...row,
              inFlightAttemptId: null,
              fairTicket: await this.nextTicketNow(),
              retryNotBefore: Date.now(),
            })
          }
        } else if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.state)) {
          if (attempt.state === 'succeeded' && row.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(graphId)
          else await this.outbox.put(graphId, { ...row, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
        }
      }
      for (const [id, attempt] of this.attempts.entries()) {
        if (attempt.state === 'queued' && ![...this.outbox.entries()].some(([, row]) => row.inFlightAttemptId === id)) {
          await this.attempts.put(id, { ...attempt, state: 'cancelled', updatedAt: Date.now(), terminalError: { code: 'dequeue_not_linearized', stage: attempt.stage, retryable: false, messageDigest: sha256Digest('dequeue_not_linearized') } })
        }
      }
      await this.recountNow()
    })
  }

  currentHead(graphId: EvidenceGraphId): CurrentHeadV1 {
    const head = this.heads.get(graphId)
    if (head === undefined) throw new EvidenceStoreError('head_missing', `Graph '${graphId}' has no head`)
    return head
  }

  committedSnapshot(digest: Sha256Digest): StoredSnapshotV1 {
    const committed = [...this.headCommits.entries()].some(([, row]) => row.snapshotDigest === digest)
      || [...this.heads.entries()].some(([, row]) => row.snapshotDigest === digest || row.previousSnapshotDigest === digest)
    if (!committed) throw new EvidenceStoreError('snapshot_not_committed', `Snapshot '${digest}' is not committed history`)
    const record = this.snapshots.get(digest)
    if (record === undefined) throw new EvidenceStoreError('snapshot_missing', `Snapshot '${digest}' is missing`)
    verifyStoredSnapshot(record)
    return record
  }

  snapshotWatermark(digest: Sha256Digest | null): number {
    if (digest === null) return 0
    return verifyStoredSnapshot(this.committedSnapshot(digest)).deterministicWatermark.nextSeqExclusive
  }

  async quarantineObject(
    graphId: EvidenceGraphId | undefined,
    table: string,
    key: string,
    code: string,
    stage: string,
    retainKeys: string[] = [],
  ): Promise<RecoveryId> {
    return this.enqueue(() => this.quarantineNow(graphId, table, key, code, stage, retainKeys))
  }

  private async quarantineNow(
    graphId: EvidenceGraphId | undefined,
    table: string,
    key: string,
    code: string,
    stage: string,
    retainKeys: string[],
  ): Promise<RecoveryId> {
    const recoveryId = newRecoveryId()
    const record: QuarantineRecord = {
      recordVersion: 'animalge.quarantine/v1', recoveryId, ...(graphId === undefined ? {} : { graphId }),
      objectTable: table, objectKey: key, code, stage, detectedAt: Date.now(), detailDigest: sha256Digest(`${table}:${key}:${code}:${stage}`), retainKeys,
    }
    await this.putImmutable(this.quarantine, recoveryId, record)
    return recoveryId
  }

  async recount(): Promise<UsageRecord> { return this.enqueue(() => this.recountNow()) }

  async deleteGarbage(
    expectedHeads: ReadonlyMap<EvidenceGraphId, string>,
    stagingIds: readonly StagingId[],
    snapshotDigests: readonly Sha256Digest[],
  ): Promise<{ deletedStaging: number; deletedOrphans: number; aborted: boolean }> {
    return this.enqueue(async () => {
      const changed = [...this.heads.entries()].some(([id, head]) => expectedHeads.get(id) !== `${String(head.snapshotDigest)}@${head.headRevision}`)
        || this.heads.size !== expectedHeads.size
      if (changed) return { deletedStaging: 0, deletedOrphans: 0, aborted: true }
      let deletedStaging = 0
      for (const id of stagingIds) if (await this.staging.delete(id)) deletedStaging++
      let deletedOrphans = 0
      for (const digest of snapshotDigests) if (await this.snapshots.delete(digest)) deletedOrphans++
      await this.recountNow()
      return { deletedStaging, deletedOrphans, aborted: false }
    })
  }

  private async recountNow(): Promise<UsageRecord> {
    const tables: Array<[string, KvTable<string, unknown>]> = [
      ['graphs', this.graphs], ['session_graphs', this.sessionGraphs],
      ['captures', this.captures], ['snapshots', this.snapshots],
      ['heads', this.heads], ['head_commits', this.headCommits],
      ['attempts', this.attempts], ['outbox', this.outbox],
      ['staging', this.staging], ['quarantine', this.quarantine],
      ['queue_clock', this.queueClock],
    ]
    let accountedBytes = 0
    let recordCount = 0
    for (const [name, table] of tables) {
      for (const [key, value] of table.entries()) {
        accountedBytes += Buffer.byteLength(name) + Buffer.byteLength(key) + Buffer.byteLength(canonicalJson(value as JsonValue))
        recordCount++
      }
    }
    let record: UsageRecord = { recordVersion: 'animalge.usage/v1', accountedBytes, recordCount: recordCount + 1, recountedAt: Date.now() }
    for (;;) {
      const total = accountedBytes + Buffer.byteLength('usage') + Buffer.byteLength('global') + Buffer.byteLength(canonicalJson(record))
      if (total === record.accountedBytes) break
      record = { ...record, accountedBytes: total }
    }
    await this.usage.put('global', record)
    return record
  }
}
