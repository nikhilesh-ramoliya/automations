import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControlLabel,
  Switch,
  MenuItem,
  Box,
  Alert,
} from '@mui/material';
import type { ScheduledJob } from '../types/scheduledJobUtils';

interface JobFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (job: Partial<ScheduledJob>) => void;
  job?: ScheduledJob | null;
  isLoading?: boolean;
}

const JobFormDialog = ({ open, onClose, onSubmit, job, isLoading }: JobFormDialogProps) => {
  const [formData, setFormData] = useState<Partial<ScheduledJob>>({
    jobName: '',
    description: '',
    apiUrl: '',
    apiMethod: 'GET',
    cronExpression: '',
    active: true,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (job) {
      setFormData(job);
    } else {
      setFormData({
        jobName: '',
        description: '',
        apiUrl: '',
        apiMethod: 'GET',
        cronExpression: '',
        active: true,
      });
    }
    setErrors({});
  }, [job, open]);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.jobName?.trim()) {
      newErrors.jobName = 'Job name is required';
    }

    if (!formData.apiUrl?.trim()) {
      newErrors.apiUrl = 'API URL is required';
    } else {
      try {
        new URL(formData.apiUrl);
      } catch {
        newErrors.apiUrl = 'Invalid URL format';
      }
    }

    if (!formData.cronExpression?.trim()) {
      newErrors.cronExpression = 'Cron expression is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formData);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{job ? 'Edit Job' : 'Create New Job'}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <TextField
            label="Job Name"
            value={formData.jobName}
            onChange={(e) => setFormData({ ...formData, jobName: e.target.value })}
            error={!!errors.jobName}
            helperText={errors.jobName}
            required
            fullWidth
          />

          <TextField
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            multiline
            rows={3}
            fullWidth
          />

          <TextField
            label="API URL"
            value={formData.apiUrl}
            onChange={(e) => setFormData({ ...formData, apiUrl: e.target.value })}
            error={!!errors.apiUrl}
            helperText={errors.apiUrl}
            required
            fullWidth
          />

          <TextField
            select
            label="HTTP Method"
            value={formData.apiMethod}
            onChange={(e) => setFormData({ ...formData, apiMethod: e.target.value })}
            fullWidth
          >
            <MenuItem value="GET">GET</MenuItem>
            <MenuItem value="POST">POST</MenuItem>
            <MenuItem value="PUT">PUT</MenuItem>
            <MenuItem value="DELETE">DELETE</MenuItem>
            <MenuItem value="PATCH">PATCH</MenuItem>
          </TextField>

          <TextField
            label="Cron Expression"
            value={formData.cronExpression}
            onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
            error={!!errors.cronExpression}
            helperText={errors.cronExpression || 'e.g., 0 0 * * * (daily at midnight)'}
            required
            fullWidth
          />

          <FormControlLabel
            control={
              <Switch
                checked={!!formData.active}
                onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
              />
            }
            label="Active"
          />

          {Object.keys(errors).length > 0 && (
            <Alert severity="error">Please fix the errors above</Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={isLoading}>
          {job ? 'Update' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default JobFormDialog;