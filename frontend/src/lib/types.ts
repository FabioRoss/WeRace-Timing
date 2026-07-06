export type Flag =
  | 'none' | 'green' | 'yellow' | 'red' | 'finish' | 'warmup' | 'stopped'

export interface RaceInfo {
  track_name: string
  event_name: string
  run_type: string
  flag: Flag
  race_time: string
  time_to_go: string
  time_of_day: string
  ended: boolean
}

export interface DriverRow {
  kart_no: string
  name: string
  position: number
  transponder: number | null
  last_lap_ms: number | null
  best_lap_ms: number | null
  best_lap_no: number | null
  gap_ahead: string
  gap_leader: string
  laps: number
  pits: number
  last_pit_ms: number | null
  total_pit_ms: number | null
  stint_time: string
  in_pit: boolean
  finished: boolean
}

export interface SourceStatus {
  kind: string
  label: string
  url: string
  connected: boolean
  last_frame_ts: number | null
  frames_received: number
  error: string
  recording: boolean
  recording_file: string
}

export interface Snapshot {
  type: 'snapshot'
  slot: number
  race: RaceInfo
  drivers: DriverRow[]
  source: SourceStatus
  session_best_ms: number | null
  session_best_kart: string
  updated_at: number
}

export interface DriverView {
  type: 'driver'
  slot: number
  kart_no?: string
  found: boolean
  position?: number
  total_karts?: number
  name?: string
  last_lap_ms?: number | null
  best_lap_ms?: number | null
  laps?: number
  pits?: number
  gap_ahead?: string
  gap_behind?: string
  kart_ahead?: string
  kart_behind?: string
  gap_leader?: string
  stint_seconds?: number | null
  in_pit?: boolean
  finished?: boolean
  flag: Flag
  time_to_go: string
  race_time?: string
  run_type?: string
  ended?: boolean
  session_best_ms?: number | null
  updated_at: number
}

export interface RaceMessage {
  type: 'message'
  id: number
  ts: number
  sender: 'race_control' | 'team_manager'
  target: string[] | null
  text: string
  priority: 'info' | 'warning' | 'urgent'
}

export type LiveEvent = Snapshot | RaceMessage
export type DriverEvent = DriverView | RaceMessage

export interface KartLinks {
  kart_no: string
  name: string
  driver_token: string
  team_token: string
  driver_url: string
  team_url: string
}

export interface LapPoint {
  lap: number
  ms: number
  pos: number
}
