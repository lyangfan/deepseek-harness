import { describe, expect, it } from 'vitest'
import { canonicalDigest, canonicalJson, parseCanonicalJson, sha256Digest } from '../src/canonical-json.ts'
import { registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'canonical-json',
  acceptanceIds: ['S01-A01'],
  sessionPersistence: [],
  evidenceStorage: [],
})

describe('S01-A01 canonical JSON', () => {
  it('pins canonical bytes and digest independently of insertion order', () => {
    const left = { z: [true, null, '猪'], a: { b: 2, a: 1 } }
    const right = { a: { a: 1, b: 2 }, z: [true, null, '猪'] }
    const bytes = '{"a":{"a":1,"b":2},"z":[true,null,"猪"]}'
    expect(canonicalJson(left)).toBe(bytes)
    expect(canonicalJson(right)).toBe(bytes)
    expect(canonicalDigest(left)).toBe('sha256:3060fa3cbdb9406364e07865d4861466ce0b46e34080fdbfd41cb00174b26e71')
    expect(sha256Digest(bytes)).toBe(canonicalDigest(left))
  })

  it.each([
    undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, Symbol('x'), () => 1,
    new Date(), Object.assign(Object.create({ inherited: true }), { own: true }),
  ])('rejects unsupported value %#', (value) => {
    expect(() => canonicalJson(value as never)).toThrow()
  })

  it('rejects cycles, sparse arrays, accessors and lone surrogates', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const sparse = Array<number>(2); sparse[1] = 1
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 })
    for (const value of [cycle, sparse, accessor, '\ud800']) expect(() => canonicalJson(value as never)).toThrow()
  })

  it('parses strict JSON and rejects duplicate keys and trailing data', () => {
    expect(canonicalJson(parseCanonicalJson('{"b":2,"a":1}'))).toBe('{"a":1,"b":2}')
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(/duplicate/)
    expect(() => parseCanonicalJson('{} true')).toThrow(/trailing/)
  })
})

describe('S01-A01 canonical golden breadth', () => {
  it('pins goldens for empty containers, key ordering, numbers and nesting', () => {
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({ 猪: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"猪":1}')
    expect(canonicalJson([1.5, -0.5, 1e21, 1e-7, 0.1])).toBe('[1.5,-0.5,1e+21,1e-7,0.1]')
    let deep: unknown = { leaf: true }
    for (let index = 0; index < 32; index++) deep = { [`l${index}`]: deep }
    expect(canonicalJson(deep as never)).toMatch(/^\{"l31":\{"l30":\{"l29":/)
    expect(canonicalJson(deep as never)).toContain('"l0":{"leaf":true}')
    expect(canonicalJson(deep as never)).not.toContain(' ')
  })

  it('escapes control characters and keeps surrogate pairs intact', () => {
    expect(canonicalJson({ ctrl: 'a\u0001b' })).toBe('{"ctrl":"a\\u0001b"}')
    expect(canonicalJson({ emoji: '🐷' })).toBe('{"emoji":"🐷"}')
    expect(canonicalJson({ quote: '"', backslash: '\\' })).toBe('{"backslash":"\\\\","quote":"\\""}')
    const roundTrip = parseCanonicalJson('{"ctrl":"a\\u0001b","emoji":"🐷"}')
    expect(canonicalJson(roundTrip)).toBe('{"ctrl":"a\\u0001b","emoji":"🐷"}')
  })
})
