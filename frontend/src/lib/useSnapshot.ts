import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { PdfConfig } from '../components/TimesheetPanel'
import type { Penalty, Snapshot } from './types'

export interface PodiumEntry {
  position: number
  kart_no: string
  name: string
}

/** A saved-snapshot record. Admin GET returns the full record; the public view
 * returns the same minus private notes and internal blocks. Both carry the
 * renderable `snapshot`, which feeds TimingTable/StoryStudio/PenaltyLog. */
export interface SnapshotRecord {
  id: string
  name: string
  track: string
  tags?: string[]
  created_at: number
  expires_at: number | null
  keep: boolean
  published: boolean
  trigger?: string
  slot?: number
  event_name?: string
  run_type?: string
  driver_count?: number
  podium?: PodiumEntry[]
  private_notes?: string
  public_notes?: string
  pdf_config?: PdfConfig
  group_id?: string | null
  group_name?: string
  snapshot: Snapshot
  original_penalties?: Penalty[]
}

/** Lightweight list/card projection of a snapshot (no heavy `snapshot` block). */
export type SnapshotMeta = Omit<SnapshotRecord, 'snapshot'>

/** An event: several snapshots grouped under one name, on one track. */
export interface EventGroup {
  id: string
  name: string
  track: string
  sessions: SnapshotMeta[]
}

/** Fetch a saved snapshot by URL (admin or public). Returns the record plus a
 * `refetch` for after edits — the static equivalent of useLive's snapshot. */
export function useSnapshotRecord(url: string | null, safeword = false) {
  const [record, setRecord] = useState<SnapshotRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    if (!url) return
    try {
      const r = await api<SnapshotRecord>(url, { safeword })
      setRecord(r)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [url, safeword])

  useEffect(() => {
    setLoading(true)
    void refetch()
  }, [refetch])

  return { record, error, loading, refetch }
}
