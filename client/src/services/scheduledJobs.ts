import type { ScheduledJob, JobLog } from "../types/scheduledJobUtils";

const API_BASE_URL = import.meta.env.VITE_APP_BASE_URL;

export const scheduledJobsApi = {
  getScheduledJobs: async (): Promise<ScheduledJob[]> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch scheduled jobs');
    }
    // Server returns camelCase already; just pass through
    return data.data as ScheduledJob[];
  },

  getScheduledJobById: async (id: number | string): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch scheduled job');
    }
    return data.data as ScheduledJob;
  },

  createScheduledJob: async (job: Partial<ScheduledJob>): Promise<ScheduledJob> => {
    // Map camelCase to API expected fields if necessary
    const payload: any = {
      job_name: job.jobName,
      description: job.description ?? '',
      api_url: job.apiUrl ?? '',
      api_method: job.apiMethod ?? 'GET',
      api_headers: job.apiHeaders ?? null,
      api_body: job.apiBody ?? null,
      cron_expression: job.cronExpression,
      active: job.active ?? true,
      retry_count: job.retryCount ?? 0,
      timeout_seconds: job.timeoutSeconds ?? 30,
    };
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to create scheduled job');
    }
    return data.data as ScheduledJob;
  },

  updateScheduledJob: async (id: number | string, job: Partial<ScheduledJob>): Promise<ScheduledJob> => {
    const payload: any = {
      ...(job.jobName !== undefined && { job_name: job.jobName }),
      ...(job.description !== undefined && { description: job.description }),
      ...(job.apiUrl !== undefined && { api_url: job.apiUrl }),
      ...(job.apiMethod !== undefined && { api_method: job.apiMethod }),
      ...(job.apiHeaders !== undefined && { api_headers: job.apiHeaders }),
      ...(job.apiBody !== undefined && { api_body: job.apiBody }),
      ...(job.cronExpression !== undefined && { cron_expression: job.cronExpression }),
      ...(job.active !== undefined && { active: job.active }),
      ...(job.retryCount !== undefined && { retry_count: job.retryCount }),
      ...(job.timeoutSeconds !== undefined && { timeout_seconds: job.timeoutSeconds }),
    };
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to update scheduled job');
    }
    return data.data as ScheduledJob;
  },

  deleteScheduledJob: async (id: number | string): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to delete scheduled job');
    }
  },

  toggleScheduledJobStatus: async (id: number | string): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}/toggle`, {
      method: 'PATCH',
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to toggle job status');
    }
    return data.data as ScheduledJob;
  },

  executeJobManually: async (id: number | string): Promise<any> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}/execute`, {
      method: 'POST',
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to execute job');
    }
    return data.data;
  },
};

export const logsApi = {
  getAllLogs: async (filters?: { job_id?: number; status?: string }): Promise<JobLog[]> => {
    const params = new URLSearchParams();
    if (filters?.job_id) params.append('job_id', filters.job_id.toString());
    if (filters?.status) params.append('status', filters.status);

    const response = await fetch(`${API_BASE_URL}/logs?${params.toString()}`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch logs');
    }
    return data.data;
  },

  getLogById: async (id: number): Promise<JobLog> => {
    const response = await fetch(`${API_BASE_URL}/logs/${id}`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch log');
    }
    return data.data;
  },

  getLogsByJobId: async (jobId: number): Promise<JobLog[]> => {
    const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/logs`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch logs');
    }
    return data.data;
  },
};