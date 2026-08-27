/** Strict canonical JSON codec used by every Evidence digest. */

import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { Sha256Digest } from './types.ts'

const isLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (isLoneSurrogate(value)) throw new TypeError('canonical JSON rejects lone surrogate strings')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('canonical JSON requires finite non-negative-zero numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON rejects ${typeof value}`)
  if (seen.has(value)) throw new TypeError('canonical JSON rejects cycles')
  const prototype = Reflect.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('canonical JSON rejects exotic arrays')
    seen.add(value)
    const output: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError('canonical JSON rejects sparse arrays')
      output.push(encode(value[index], seen))
    }
    seen.delete(value)
    return `[${output.join(',')}]`
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON requires plain objects')
  seen.add(value)
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const output = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('canonical JSON rejects accessors')
    if (isLoneSurrogate(key)) throw new TypeError('canonical JSON rejects lone surrogate keys')
    return `${JSON.stringify(key)}:${encode(descriptor.value, seen)}`
  })
  seen.delete(value)
  return `{${output.join(',')}}`
}

/**
 * Encode one strict lossless JSON value without whitespace or trailing newline.
 * @param value Strict JSON value to encode.
 * @returns Canonical JSON bytes represented as a string.
 */
export function canonicalJson(value: JsonValue): string {
  return encode(value, new Set())
}

/**
 * Hash UTF-8 bytes and return the tagged wire digest.
 * @param bytes String or byte sequence to hash.
 * @returns Lowercase tagged SHA-256 digest.
 */
export function sha256Digest(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Canonicalize and hash one strict JSON value.
 * @param value Strict JSON value to canonicalize.
 * @returns Digest of the canonical UTF-8 bytes.
 */
export function canonicalDigest(value: JsonValue): Sha256Digest {
  return sha256Digest(canonicalJson(value))
}

/**
 * Parse JSON while rejecting duplicate object keys, then validate it through the canonical encoder.
 * @param text JSON text to parse.
 * @returns Detached strict JSON value.
 */
export function parseCanonicalJson(text: string): JsonValue {
  let offset = 0
  const whitespace = (): void => { while (/\s/u.test(text[offset] ?? '')) offset++ }
  const parseString = (): string => {
    const start = offset
    offset++
    let escaped = false
    while (offset < text.length) {
      const char = text[offset++] as string
      if (!escaped && char === '"') return JSON.parse(text.slice(start, offset)) as string
      if (!escaped && char === '\\') escaped = true
      else escaped = false
    }
    throw new SyntaxError('unterminated JSON string')
  }
  const parseValue = (): JsonValue => {
    whitespace()
    const char = text[offset]
    if (char === '"') return parseString()
    if (char === '[') {
      offset++
      const values: JsonValue[] = []
      whitespace()
      if (text[offset] === ']') { offset++; return values }
      for (;;) {
        values.push(parseValue())
        whitespace()
        if (text[offset] === ']') { offset++; return values }
        if (text[offset++] !== ',') throw new SyntaxError('expected comma in JSON array')
      }
    }
    if (char === '{') {
      offset++
      const record: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
      const keys = new Set<string>()
      whitespace()
      if (text[offset] === '}') { offset++; return record }
      for (;;) {
        whitespace()
        if (text[offset] !== '"') throw new SyntaxError('expected JSON object key')
        const key = parseString()
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON object key '${key}'`)
        keys.add(key)
        whitespace()
        if (text[offset++] !== ':') throw new SyntaxError('expected colon after JSON object key')
        record[key] = parseValue()
        whitespace()
        if (text[offset] === '}') { offset++; return record }
        if (text[offset++] !== ',') throw new SyntaxError('expected comma in JSON object')
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(offset))
    if (match === null) throw new SyntaxError(`invalid JSON token at offset ${offset}`)
    offset += match[0].length
    return JSON.parse(match[0]) as JsonValue
  }
  const value = parseValue()
  whitespace()
  if (offset !== text.length) throw new SyntaxError(`trailing JSON data at offset ${offset}`)
  canonicalJson(value)
  return value
}
