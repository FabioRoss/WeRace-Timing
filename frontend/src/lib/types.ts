export type Flag =
  | 'none' | 'green' | 'yellow' | 'red' | 'finish' | 'warmup' | 'stopped'

export interface RaceInfo {
  track_name: string
  event_name: string
  run_type: string
  session_kind: 'unknown' | 'race' | 'timed'
  flag: Flag
  race_time: string
  time_to_go: string
  // Countdown anchor: togo_ms remaining at server time togo_ts; tick down
  // locally while counting, re-sync on every snapshot.
  togo_ms: number | null
  togo_ts: number | null
  counting: boolean
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
  s1_ms: number | null
  s2_ms: number | null
  s3_ms: number | null
  speed: string
  gap_ahead: string
  gap_leader: string
  total_time_ms: number | null
  laps: number
  pits: number
  last_pit_ms: number | null
  total_pit_ms: number | null
  stint_time: string
  stint_seconds: number | null
  in_pit: boolean
  pit_state: '' | 'in' | 'out'
  finished: boolean
  // Progress anchor: at prog_ts (epoch s) the kart was at lap fraction
  // prog_from, expected to reach prog_to after prog_ms milliseconds.
  prog_ts: number | null
  prog_from: number
  prog_to: number
  prog_ms: number | null
  pit_since_ts: number | null
}

export interface Penalty {
  id: number
  ts: number
  kart_no: string
  kind: 'time' | 'lap' | 'warning'
  seconds: number       // time penalties: seconds added to total time
  laps: number          // lap penalties: laps subtracted from the count
  reason: string
  served: boolean       // time penalties: served in the pit lane
  notified: boolean
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
  replay_pos: number | null
  replay_count: number | null
  replay_elapsed_s: number | null
  replay_duration_s: number | null
}

export interface Snapshot {
  type: 'snapshot'
  slot: number
  race: RaceInfo
  drivers: DriverRow[]
  source: SourceStatus
  flag_override: Flag | null
  recompute_positions: boolean
  auto_pitlane: boolean
  hide_team_penalties?: boolean
  session_best_ms: number | null
  session_best_kart: string
  penalties: Penalty[]
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
  togo_ms?: number | null
  togo_ts?: number | null
  counting?: boolean
  race_time?: string
  run_type?: string
  ended?: boolean
  session_best_ms?: number | null
  penalties?: Penalty[]
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
  pit: boolean
  ts: number          // wall time of the crossing (epoch seconds)
}
