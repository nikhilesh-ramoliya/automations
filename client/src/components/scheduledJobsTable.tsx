import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  CircularProgress,
  Alert,
  Typography,
  Box,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { scheduledJobsApi, type ScheduledJob } from '../services/scheduledJobs';

const ScheduledJobsTable = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduledJobs'],
    queryFn: scheduledJobsApi.getScheduledJobs,
  });

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error">
        Error loading scheduled jobs: {(error as Error).message}
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom sx={{ mb: 3 }}>
        Scheduled Jobs
      </Typography>
      
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Job ID</TableCell>
              <TableCell>Job Name</TableCell>
              <TableCell>Description</TableCell>
              {/* <TableCell>API Endpoint</TableCell> */}
              {/* <TableCell>Cron Expression</TableCell> */}
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data?.map((job: ScheduledJob) => (
              <TableRow key={job.job_id} hover>
                <TableCell>{job.job_id}</TableCell>
                <TableCell>
                  <Typography variant="body2" fontWeight="medium">
                    {job.job_name}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color="text.secondary">
                    {job.description}
                  </Typography>
                </TableCell>
                {/* <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {job.api}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {job.cron}
                  </Typography>
                </TableCell> */}
                <TableCell>
                  <Chip
                    label={job.active ? 'Active' : 'Inactive'}
                    color={job.active ? 'success' : 'default'}
                    size="small"
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

export default ScheduledJobsTable;