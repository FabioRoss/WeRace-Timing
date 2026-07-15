import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Landing } from './pages/Landing'
import { GeneralDashboard } from './pages/GeneralDashboard'
import { DriverDashboard } from './pages/DriverDashboard'
import { TeamDashboard } from './pages/TeamDashboard'
import { RaceControl } from './pages/RaceControl'
import { StaffDashboard } from './pages/StaffDashboard'
import { ExportPage } from './pages/ExportPage'
import { SnapshotManager } from './pages/SnapshotManager'
import { SnapshotEditor } from './pages/SnapshotEditor'
import { ResultsIndex } from './pages/ResultsIndex'
import { ResultsDetail } from './pages/ResultsDetail'
import { EventDetail } from './pages/EventDetail'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/e/:slot" element={<GeneralDashboard />} />
        <Route path="/e/:slot/driver/:token" element={<DriverDashboard />} />
        <Route path="/e/:slot/team/:token" element={<TeamDashboard />} />
        <Route path="/e/:slot/control" element={<RaceControl />} />
        <Route path="/e/:slot/staff" element={<StaffDashboard />} />
        <Route path="/e/:slot/export" element={<ExportPage />} />
        <Route path="/admin/snapshots" element={<SnapshotManager />} />
        <Route path="/admin/snapshots/:id" element={<SnapshotEditor />} />
        <Route path="/results" element={<ResultsIndex />} />
        <Route path="/results/:id" element={<ResultsDetail />} />
        <Route path="/events/:id" element={<EventDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
