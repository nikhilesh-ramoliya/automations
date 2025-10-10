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
    job_name: '',
    description: '',
    api_url: '',
    api_method: 'GET',
    cron_expression: '',
    active: true,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (job) {
      setFormData(job);
    } else {
      setFormData({
        job_name: '',
        description: '',
        api_url: '',
        api_method: 'GET',
        cron_expression: '',
        active: true,
      });
    }
    setErrors({});
  }, [job, open]);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.job_name?.trim()) {
      newErrors.job_name = 'Job name is required';
    }

    if (!formData.api_url?.trim()) {
      newErrors.api_url = 'API URL is required';
    } else {
      try {
        new URL(formData.api_url);
      } catch {
        newErrors.api_url = 'Invalid URL format';
      }
    }

    if (!formData.cron_expression?.trim()) {
      newErrors.cron_expression = 'Cron expression is required';
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
            value={formData.job_name}
            onChange={(e) => setFormData({ ...formData, job_name: e.target.value })}
            error={!!errors.job_name}
            helperText={errors.job_name}
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
            value={formData.api_url}
            onChange={(e) => setFormData({ ...formData, api_url: e.target.value })}
            error={!!errors.api_url}
            helperText={errors.api_url}
            required
            fullWidth
          />

          <TextField
            select
            label="HTTP Method"
            value={formData.api_method}
            onChange={(e) => setFormData({ ...formData, api_method: e.target.value })}
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
            value={formData.cron_expression}
            onChange={(e) => setFormData({ ...formData, cron_expression: e.target.value })}
            error={!!errors.cron_expression}
            helperText={errors.cron_expression || 'e.g., 0 0 * * * (daily at midnight)'}
            required
            fullWidth
          />

          <FormControlLabel
            control={
              <Switch
                checked={formData.active}
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