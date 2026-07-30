// The live half of the Live module.
//
// Its OWN namespace (`/live`), never the default one: the default namespace is
// where every visitor's browser connects, so anything sent there is public.
// This stream carries internal payloads and passport ids.
//
// The token goes in socket.io's `auth` field rather than the query string —
// query strings land in access logs and proxy history.
import { io, type Socket } from 'socket.io-client'
import type { FeedEvent } from './live'

export function connectLive(
  token: string,
  onBatch: (events: FeedEvent[], dropped: number) => void,
  onState?: (connected: boolean) => void,
): () => void {
  let socket: Socket | null = null
  try {
    socket = io('/live', { transports: ['websocket', 'polling'], reconnection: true, auth: { token } })
    socket.on('connect', () => onState?.(true))
    socket.on('disconnect', () => onState?.(false))
    socket.on('connect_error', () => onState?.(false))
    socket.on('live.batch', (p: { events: FeedEvent[]; dropped: number }) => onBatch(p.events || [], p.dropped || 0))
  } catch {
    onState?.(false)   // the dashboard still renders from the REST reads
  }
  return () => { socket?.removeAllListeners(); socket?.disconnect() }
}
