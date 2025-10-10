import { useState } from 'react';
import { Container, Tabs, Tab, Box } from '@mui/material';
import ScheduledJobsTable from './components/scheduledJobsTable';
import LogsTable from './components/logTable';

function App() {
  const [currentTab, setCurrentTab] = useState(0);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setCurrentTab(newValue);
  };

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={currentTab} onChange={handleTabChange}>
          <Tab label="Scheduled Jobs" />
          <Tab label="Execution Logs" />
        </Tabs>
      </Box>

      <Box hidden={currentTab !== 0}>
        <ScheduledJobsTable />
      </Box>

      <Box hidden={currentTab !== 1}>
        <LogsTable />
      </Box>
    </Container>
  );
}

export default App;