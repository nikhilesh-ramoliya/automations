import { useState } from 'react';
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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
} from '@mui/material';
import { Visibility as VisibilityIcon } from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { logsApi, scheduledJobsApi } from '../services/scheduledJobs';
import type { JobLog } from '../types/scheduledJobUtils';
import LogDetailModal from './logDetailModal';

const LogsTable = () => {
  const [selectedLog, setSelectedLog] = useState<JobLog | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [jobFilter, setJobFilter] = useState<number | ''>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const { data: jobs } = useQuery({
    queryKey: ['scheduledJobs'],
    queryFn: scheduledJobsApi.getScheduledJobs,
  });

  const { data: logs, isLoading, error } = useQuery({
    queryKey: ['logs', jobFilter, statusFilter],
    queryFn: () => logsApi.getAllLogs({
      job_id: jobFilter || undefined,
      status: statusFilter || undefined,
    }),
  });

  const handleViewDetails = (log: JobLog) => {
    setSelectedLog(log);
    setModalOpen(true);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'success';
      case 'failure':
        return 'error';
      case 'timeout':
        return 'warning';
      default:
        return 'default';
    }
  };

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
        Error loading logs: {(error as Error).message}
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Job Execution Logs
      </Typography>

      <Box display="flex" gap={2} mb={3}>
        <FormControl sx={{ minWidth: 200 }}>
          <InputLabel>Filter by Job</InputLabel>
          <Select
            value={jobFilter}
            onChange={(e) => setJobFilter(e.target.value as number | '')}
            label="Filter by Job"
          >
            <MenuItem value="">All Jobs</MenuItem>
            {jobs?.map((job) => (
              <MenuItem key={Number(job.jobId)} value={Number(job.jobId)}>
                {job.jobName}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl sx={{ minWidth: 200 }}>
          <InputLabel>Filter by Status</InputLabel>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            label="Filter by Status"
          >
            <MenuItem value="">All Statuses</MenuItem>
            <MenuItem value="success">Success</MenuItem>
            <MenuItem value="failure">Failure</MenuItem>
            <MenuItem value="timeout">Timeout</MenuItem>
          </Select>
        </FormControl>
      </Box>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Log ID</TableCell>
              <TableCell>Reference ID</TableCell>
              <TableCell>Job Name</TableCell>
              <TableCell>Execution Time</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Response Code</TableCell>
              <TableCell>Triggered By</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {logs?.map((log: JobLog) => (
              <TableRow key={log.log_id} hover>
                <TableCell>{log.log_id}</TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {log.reference_id.substring(0, 8)}...
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" fontWeight="medium">
                    {log.job_name || `Job ${log.job_id}`}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">
                    {new Date(log.execution_time).toLocaleString()}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    label={log.status}
                    color={getStatusColor(log.status)}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  <Typography variant="body2">
                    {log.execution_duration_ms}ms
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    label={log.response_status_code || 'N/A'}
                    size="small"
                    color={
                      log.response_status_code >= 200 && log.response_status_code < 300
                        ? 'success'
                        : 'error'
                    }
                  />
                </TableCell>
                <TableCell>
                  <Chip label={log.triggered_by} size="small" variant="outlined" />
                </TableCell>
                <TableCell>
                  <Tooltip title="View Details">
                    <IconButton
                      size="small"
                      color="primary"
                      onClick={() => handleViewDetails(log)}
                    >
                      <VisibilityIcon />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {logs?.length === 0 && (
        <Box display="flex" justifyContent="center" p={4}>
          <Typography color="text.secondary">No logs found</Typography>
        </Box>
      )}

      <LogDetailModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedLog(null);
        }}
        log={selectedLog}
      />
    </Box>
  );
};

export default LogsTable;