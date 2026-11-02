const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { inspect } = require('./runtime')
const { backoff } = require('./recovery')
const { log } = require('./config')

class Supervisor {
  constructor(config, dependencies = {}) {
    this.config = config
    this.spawn = dependencies.spawn || spawn
    this.inspect = dependencies.inspect || inspect
    this.random = dependencies.random || Math.random
    this.file = path.join(path.dirname(config.stateFile), 'supervisor.json')
    this.state = 'starting'; this.restarts = 0; this.failures = 0; this.child = null
    this.stopping = false; this.retryAt = null; this.detail = null
  }
  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const state = { pid: process.pid, childPid: this.child?.pid || null, state: this.state,
      restarts: this.restarts, retryAt: this.retryAt, detail: this.detail, updatedAt: new Date().toISOString() }
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
  }
  start() {
    this.lastTick = Date.now(); this.resumeGraceUntil = 0
    this.write()
    this.timer = setInterval(() => this.tick(), 5000)
    this.launch()
  }
  launch() {
    if (this.stopping || this.child || this.state === 'attention') return
    const existing = this.inspect(this.config)
    if (existing.running) {
      this.state = 'attention'; this.detail = { message: 'Another Clara worker is already running. Stop it before restarting.' }
      this.write(); return
    }
    this.state = 'starting'; this.retryAt = null; this.detail = null; this.startedAt = Date.now()
    const child = this.child = this.spawn(process.execPath, ['index.js'], {
      cwd: this.config.root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true
    })
    child.on('message', message => {
      if (message?.type === 'attention') this.attentionDetail = message.detail
    })
    child.once('error', error => {
      this.detail = { message: `Worker could not start: ${error.message}` }
      log('WORKER_START_FAILED', this.detail)
    })
    child.once('close', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      if (code === 78 || this.attentionDetail) {
        this.state = 'attention'; this.detail = this.attentionDetail || { message: 'Clara requires manual attention.' }
        this.attentionDetail = null; this.retryAt = null
        log('SUPERVISOR_ATTENTION', this.detail)
      } else {
        if (Date.now() - this.startedAt >= 300000) this.failures = 0
        const delayMs = backoff(++this.failures, { baseMs: 5000, random: this.random })
        this.state = 'recovering'; this.restarts++
        this.retryAt = new Date(Date.now() + delayMs).toISOString()
        this.detail = { code, signal, delayMs, message: 'Worker exited; automatic restart scheduled.' }
        log('WORKER_RESTART_SCHEDULED', this.detail)
        this.retryTimer = setTimeout(() => this.launch(), delayMs)
      }
      this.write()
    })
    this.write()
    log('WORKER_STARTED', { pid: child.pid })
  }
  tick() {
    if (this.stopping) return
    const now = Date.now()
    if (now - this.lastTick > 75000) {
      // The parent was suspended too; allow the worker to refresh its heartbeat after wake.
      this.resumeGraceUntil = now + 90000
      log('SUPERVISOR_HOST_RESUMED', { graceSeconds: 90 })
    }
    this.lastTick = now
    if (this.child) {
      const status = this.inspect(this.config)
      const heartbeat = status.pid === this.child.pid && Date.parse(status.updatedAt)
      if (now >= this.resumeGraceUntil && ((!heartbeat && now - this.startedAt > 90000) ||
          (heartbeat && now - heartbeat > 90000))) {
        log('WORKER_UNRESPONSIVE', { pid: this.child.pid })
        this.child.kill('SIGKILL')
      } else if (status.running) this.state = 'running'
    }
    this.write()
  }
  async stop() {
    this.stopping = true
    clearTimeout(this.retryTimer); clearInterval(this.timer)
    const child = this.child
    if (child) {
      await new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 6000)
        child.once('close', () => { clearTimeout(force); resolve() })
        child.kill('SIGTERM')
      })
    }
    this.state = 'stopped'; this.retryAt = null; this.write()
  }
}

module.exports = { Supervisor }
