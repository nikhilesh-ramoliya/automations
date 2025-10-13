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
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as PlayIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { scheduledJobsApi } from '../services/scheduledJobs';
import type { ScheduledJob } from '../types/scheduledJobUtils';
import JobFormDialog from './jobFormDialog';

const ScheduledJobsTable = () => {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<ScheduledJob | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [jobToDelete, setJobToDelete] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' });

  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduledJobs'],
    queryFn: scheduledJobsApi.getScheduledJobs,
  });

  const createMutation = useMutation({
    mutationFn: scheduledJobsApi.createScheduledJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledJobs'] });
      setFormOpen(false);
      setSnackbar({ open: true, message: 'Job created successfully', severity: 'success' });
    },
    onError: (error: Error) => {
      setSnackbar({ open: true, message: error.message, severity: 'error' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, job }: { id: number; job: Partial<ScheduledJob> }) =>
      scheduledJobsApi.updateScheduledJob(id, job),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledJobs'] });
      setFormOpen(false);
      setSelectedJob(null);
      setSnackbar({ open: true, message: 'Job updated successfully', severity: 'success' });
    },
    onError: (error: Error) => {
      setSnackbar({ open: true, message: error.message, severity: 'error' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: scheduledJobsApi.deleteScheduledJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledJobs'] });
      setDeleteDialogOpen(false);
      setJobToDelete(null);
      setSnackbar({ open: true, message: 'Job deleted successfully', severity: 'success' });
    },
    onError: (error: Error) => {
      setSnackbar({ open: true, message: error.message, severity: 'error' });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: scheduledJobsApi.toggleScheduledJobStatus,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledJobs'] });
      setSnackbar({ open: true, message: 'Job status updated', severity: 'success' });
    },
    onError: (error: Error) => {
      setSnackbar({ open: true, message: error.message, severity: 'error' });
    },
  });

  const executeMutation = useMutation({
    mutationFn: scheduledJobsApi.executeJobManually,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledJobs'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
      setSnackbar({ open: true, message: 'Job executed successfully', severity: 'success' });
    },
    onError: (error: Error) => {
      setSnackbar({ open: true, message: error.message, severity: 'error' });
    },
  });

  const handleCreateNew = () => {
    setSelectedJob(null);
    setFormOpen(true);
  };

  const handleEdit = (job: ScheduledJob) => {
    setSelectedJob(job);
    setFormOpen(true);
  };

  const handleDelete = (id: number) => {
    setJobToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (jobToDelete) {
      deleteMutation.mutate(jobToDelete);
    }
  };

  const handleToggle = (id: number) => {
    toggleMutation.mutate(id);
  };

  const handleExecute = (id: number) => {
    executeMutation.mutate(id);
  };

  const handleFormSubmit = (job: Partial<ScheduledJob>) => {
    if (selectedJob) {
      updateMutation.mutate({ id: selectedJob.jobId, job });
    } else {
      createMutation.mutate(job);
    }
  };

  const handleViewLogs = (jobId: number) => {
    // Navigate to logs page with filter (implement routing later)
    window.location.href = `#logs?job_id=${jobId}`;
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
        Error loading scheduled jobs: {(error as Error).message}
      </Alert>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4">Scheduled Jobs</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleCreateNew}
        >
          Create New Job
        </Button>
      </Box>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Job Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>API URL</TableCell>
              <TableCell>Cron</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Last Run</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data?.map((job: ScheduledJob) => (
              <TableRow key={job.jobId} hover>
                <TableCell>{job.jobId}</TableCell>
                <TableCell>
                  <Typography variant="body2" fontWeight="medium">
                    {job.jobName}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 200 }}>
                    {job.description}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }} noWrap>
                    {job.apiUrl}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {job.cronExpression}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    label={job.active ? 'Active' : 'Inactive'}
                    color={job.active ? 'success' : 'default'}
                    size="small"
                    onClick={() => handleToggle(Number(job.jobId))}
                    sx={{ cursor: 'pointer' }}
                  />
                </TableCell>
                <TableCell>
                  {job.lastRunAt ? (
                    <Box>
                      <Typography variant="body2">
                        {new Date(job.lastRunAt).toLocaleString()}
                      </Typography>
                      <Chip
                        label={job.lastRunStatus || 'N/A'}
                        color={job.lastRunStatus === 'success' ? 'success' : 'error'}
                        size="small"
                        sx={{ mt: 0.5 }}
                      />
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Never run
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Box display="flex" gap={0.5}>
                    <Tooltip title="Execute Now">
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => handleExecute(Number(job.jobId))}
                        disabled={executeMutation.isPending}
                      >
                        <PlayIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="View Logs">
                      <IconButton
                        size="small"
                        color="info"
                        onClick={() => handleViewLogs(Number(job.jobId))}
                      >
                        <HistoryIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton
                        size="small"
                        color="warning"
                        onClick={() => handleEdit(job)}
                      >
                        <EditIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => handleDelete(Number(job.jobId))}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <JobFormDialog
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setSelectedJob(null);
        }}
        onSubmit={handleFormSubmit}
        job={selectedJob}
        isLoading={createMutation.isPending || updateMutation.isPending}
      />

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Confirm Delete</DialogTitle>
        <DialogContent>
          Are you sure you want to delete this job? This action cannot be undone and will also delete all associated logs.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={confirmDelete}
            color="error"
            variant="contained"
            disabled={deleteMutation.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar({ ...snackbar, open: false })}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default ScheduledJobsTable;