import type { InMemoryStore } from '../stores/memory.js'

export interface HealthStatus {
  storeSize: number
  pendingInflight: number
  uptimeMs: number
  lastError?: { code: string; message: string; timestamp: number }
  lastSuccessAt?: number
}

let globalInflight = 0
let startTime = Date.now()
let globalLastError: { code: string; message: string; timestamp: number } | undefined
let globalLastSuccessAt: number | undefined

export function registerInflight(_scope: string): void {
  globalInflight++
}

export function unregisterInflight(_scope: string): void {
  globalInflight = Math.max(0, globalInflight - 1)
}

export function recordError(_scope: string, code: string, message: string): void {
  globalLastError = { code, message, timestamp: Date.now() }
}

export function recordSuccess(_scope: string): void {
  globalLastSuccessAt = Date.now()
}

export function createHealthCheck(store: InMemoryStore): () => HealthStatus {
  return () => {
    return {
      storeSize: store.size(),
      pendingInflight: globalInflight,
      uptimeMs: Date.now() - startTime,
      lastError: globalLastError,
      lastSuccessAt: globalLastSuccessAt,
    }
  }
}
