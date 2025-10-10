import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Chip,
  Divider,
} from '@mui/material';
import type { JobLog } from '../types/scheduledJobUtils';

interface LogDetailModalProps {
  open: boolean;
  onClose: () => void;
  log: JobLog | null;
}

const LogDetailModal = ({ open, onClose, log }: LogDetailModalProps) => {
  if (!log) return null;

  const formatJSON = (data: any) => {
    if (!data) return 'N/A';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">Log Details</Typography>
          <Chip
            label={log.status}
            color={log.status === 'success' ? 'success' : 'error'}
            size="small"
          />
        </Box>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Log ID
            </Typography>
            <Typography variant="body1">{log.log_id}</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Reference ID
            </Typography>
            <Typography variant="body1" sx={{ fontFamily: 'monospace' }}>
              {log.reference_id}
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Job Name
            </Typography>
            <Typography variant="body1">{log.job_name || `Job ${log.job_id}`}</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Execution Time
            </Typography>
            <Typography variant="body1">
              {new Date(log.execution_time).toLocaleString()}
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Duration
            </Typography>
            <Typography variant="body1">{log.execution_duration_ms}ms</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Response Status Code
            </Typography>
            <Chip
              label={log.response_status_code || 'N/A'}
              size="small"
              color={
                log.response_status_code >= 200 && log.response_status_code < 300
                  ? 'success'
                  : 'error'
              }
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Triggered By
            </Typography>
            <Typography variant="body1">{log.triggered_by}</Typography>
          </Box>

          <Divider />

          {log.request_payload && (
            <Box>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Request Payload
              </Typography>
              <Box
                sx={{
                  backgroundColor: '#f5f5f5',
                  p: 2,
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  overflow: 'auto',
                  maxHeight: 200,
                }}
              >
                <pre>{formatJSON(log.request_payload)}</pre>
              </Box>
            </Box>
          )}

          {log.response_data && (
            <Box>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Response Data
              </Typography>
              <Box
                sx={{
                  backgroundColor: '#f5f5f5',
                  p: 2,
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  overflow: 'auto',
                  maxHeight: 200,
                }}
              >
                <pre>{formatJSON(log.response_data)}</pre>
              </Box>
            </Box>
          )}

          {log.error_message && (
            <Box>
              <Typography variant="subtitle2" color="error" gutterBottom>
                Error Message
              </Typography>
              <Box
                sx={{
                  backgroundColor: '#ffebee',
                  p: 2,
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                }}
              >
                {log.error_message}
              </Box>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default LogDetailModal;