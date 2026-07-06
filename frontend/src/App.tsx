import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Landing } from './pages/Landing'
import { GeneralDashboard } from './pages/GeneralDashboard'
import { DriverDashboard } from './pages/DriverDashboard'
import { TeamDashboard } from './pages/TeamDashboard'
import { RaceControl } from './pages/RaceControl'
import { StaffDashboard } from './pages/StaffDashboard'

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
      </Routes>
    </BrowserRouter>
  )
}
