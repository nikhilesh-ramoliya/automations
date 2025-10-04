import { Container } from '@mui/material';
import ScheduledJobsTable from './components/scheduledJobsTable';

function App() {
  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <ScheduledJobsTable />
    </Container>
  );
}

export default App;