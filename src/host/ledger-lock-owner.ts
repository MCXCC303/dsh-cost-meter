/** Process identity for local ledger locks; PID liveness alone cannot detect reuse. */
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { hostname } from 'node:os'
import { join } from 'node:path'

const host = hostname()
const ownStartMs = Date.now() - process.uptime() * 1000
const commandOptions: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: 2000, maxBuffer: 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
let ownIdentity, clockTicks

function processIdentity(pid, legacy = false) {
  try {
    if (process.platform === 'linux') {
      // comm can itself contain spaces and ')'; field 22 follows its last ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
      if (!/^\d+$/.test(start ?? '')) return null
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const namespace = readlinkSync(`/proc/${pid}/ns/pid`)
      if (!/^[a-f0-9-]{36}$/.test(boot) || !namespace) return null
      let startedAtMs = pid === process.pid ? ownStartMs : null
      if (legacy && pid !== process.pid) {
        clockTicks ??= Number(execFileSync('getconf', ['CLK_TCK'], commandOptions).trim())
        const bootTime = readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]
        if (Number.isFinite(clockTicks) && clockTicks > 0 && bootTime) startedAtMs = (Number(bootTime) + Number(start) / clockTicks) * 1000
      }
      return { platform: 'linux', boot, namespace, start, startedAtMs }
    }
    if (process.platform === 'win32') {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const start = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], commandOptions).trim()
      if (!/^\d+$/.test(start)) return null
      return { platform: 'win32', start, startedAtMs: Number(BigInt(start) / 10000n - 62135596800000n) }
    }
  } catch { /* Missing process, permissions or OS tools: ownership remains unknown. */ }
  return null
}

function localIdentity() {
  if (ownIdentity === undefined) ownIdentity = processIdentity(process.pid)
  return ownIdentity
}

export function ledgerLockOwner() {
  return JSON.stringify({ version: 1, host, identity: localIdentity() })
}

/** Only dead processes, changed native identities or pre-birth legacy files qualify. */
export function staleLedgerLockOwner(path, pid, identities = new Map()) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false
  const text = readFileSync(path, 'utf8')
  let previous
  if (text !== '') {
    try { previous = JSON.parse(text) } catch { /* Incomplete owner write is not stale. */ }
    if (previous?.host && previous.host !== host) return false
    const local = localIdentity()
    // Same-boot locks in another PID namespace cannot be probed from this one.
    if (previous?.identity?.platform === 'linux' && local?.platform === 'linux'
      && previous.identity.boot === local.boot && previous.identity.namespace !== local.namespace) return false
  }
  try { process.kill(pid, 0) } catch (error: any) {
    // TODO(types): 收敛为 NodeJS.ErrnoException 后再去掉 any。
    return error.code === 'ESRCH'
  }
  if (pid !== process.pid && !identities.has(pid)) identities.set(pid, processIdentity(pid, text === ''))
  const current = pid === process.pid ? localIdentity() : identities.get(pid)
  if (text === '') {
    // v1.8.13 and earlier wrote empty owner files. Allow for timestamp precision
    // and startup-time estimation; ordinary old locks are never expired by age.
    const start = pid === process.pid ? (current?.startedAtMs ?? ownStartMs) : current?.startedAtMs
    return Number.isFinite(start) && statSync(path).mtimeMs < start - 2000
  }
  const identity = previous?.version === 1 && previous.identity
  if (!identity || !current || identity.platform !== current.platform || typeof identity.start !== 'string' || !/^\d+$/.test(identity.start)) return false
  if (current.platform === 'linux') {
    if (typeof identity.boot !== 'string' || typeof identity.namespace !== 'string') return false
    return identity.boot !== current.boot || identity.start !== current.start
  }
  return identity.start !== current.start
}
