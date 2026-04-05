/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

interface StreamSample {
  tokens: number
  timestamp: number
}

interface PartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

const tui: TuiPlugin = async (api, _options, _meta) => {
  const streamSamples = new Map<string, StreamSample[]>()

  const [version, setVersion] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const LIVE_STALE_MS = 1500
  const SAMPLE_WINDOW_MS = 5000
  const SINGLE_SAMPLE_MIN_MS = 250
  const SINGLE_SAMPLE_MAX_MS = 1000

  function estimateTokens(text: string): number {
    const byteLen = new TextEncoder().encode(text).length
    return Math.max(1, Math.ceil(byteLen / 5))
  }

  function formatTps(value: number): string {
    if (value < 0) return "-"
    if (value < 10) return value.toFixed(2)
    if (value < 100) return value.toFixed(1)
    return Math.round(value).toString()
  }

  function clearLiveSamples(sessionID: string) {
    if (streamSamples.has(sessionID)) {
      streamSamples.delete(sessionID)
      setVersion((v) => v + 1)
    }
  }

  function singleSampleDuration(samples: StreamSample[]): number {
    const elapsed = Date.now() - samples[0].timestamp
    return Math.max(SINGLE_SAMPLE_MIN_MS, Math.min(elapsed, SINGLE_SAMPLE_MAX_MS))
  }

  function activeDurationMs(samples: StreamSample[]): number {
    if (samples.length < 2) {
      return singleSampleDuration(samples)
    }
    let total = 0
    for (let i = 1; i < samples.length; i++) {
      total += Math.max(0, samples[i].timestamp - samples[i - 1].timestamp)
    }
    const now = Date.now()
    const tail = now - samples[samples.length - 1].timestamp
    total += Math.min(tail, 1000)
    return Math.max(total, SINGLE_SAMPLE_MIN_MS)
  }

  function calcLiveTps(sessionID: string): number {
    if (api.state.session.status(sessionID)?.type === "idle") return -1

    const samples = streamSamples.get(sessionID) ?? []
    const now = Date.now()
    const cutoff = now - SAMPLE_WINDOW_MS
    const active = samples.filter((s) => s.timestamp >= cutoff)

    if (active.length === 0) return -1

    const last = active[active.length - 1]
    if (now - last.timestamp > LIVE_STALE_MS) return -1

    const totalTokens = active.reduce((sum, s) => sum + s.tokens, 0)
    const durationMs = activeDurationMs(active)
    if (durationMs <= 0) return -1

    return (totalTokens / durationMs) * 1000
  }

  const unsubDelta = api.event.on("message.part.delta" as unknown as "message.part.delta", (evt: PartDeltaEvent) => {
    const sessionID = evt.properties.sessionID
    if (!sessionID) return
    if (api.state.session.status(sessionID)?.type === "idle") return

    if (evt.properties.field !== "text") return

    const parts = api.state.part(evt.properties.messageID)
    const hasTextOrReasoning = parts?.some(
      (p) => p.type === "text" || p.type === "reasoning",
    )
    if (!hasTextOrReasoning) return

    const deltaText = evt.properties.delta
    if (!deltaText || typeof deltaText !== "string") return

    const tokens = estimateTokens(deltaText)
    const now = Date.now()

    let samples = streamSamples.get(sessionID)
    if (!samples) {
      samples = []
      streamSamples.set(sessionID, samples)
    }
    samples.push({ tokens, timestamp: now })

    setVersion((v) => v + 1)
  })

  const unsubUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return

    const sessionID = info.sessionID

    if (info.time.completed) {
      streamSamples.delete(sessionID)
      setVersion((v) => v + 1)
    }
  })

  const unsubPartUpdated = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return

    const sessionID = part.sessionID
    const state = part.state

    if (state.status === "running" || state.status === "completed" || state.status === "error") {
      clearLiveSamples(sessionID)
    }
  })

  const interval = setInterval(() => {
    const now = Date.now()
    const cutoff = now - SAMPLE_WINDOW_MS
    for (const [sessionID, samples] of streamSamples) {
      const pruned = samples.filter((s) => s.timestamp >= cutoff)
      if (pruned.length !== samples.length) {
        streamSamples.set(sessionID, pruned)
      }
    }
    setTick((t) => t + 1)
  }, 1000)

  api.lifecycle.onDispose(() => {
    unsubDelta()
    unsubUpdated()
    unsubPartUpdated()
    clearInterval(interval)
  })

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const sessionID = props.session_id

        const liveTps = createMemo(() => {
          version()
          tick()
          return calcLiveTps(sessionID)
        })

        const textMuted = ctx.theme.current.textMuted

        return (
          <text fg={textMuted}>
            TPS {formatTps(liveTps())}
          </text>
        )
      },
    },
  })
}

export default {
  id: "opencode-tps",
  tui,
}
