import type { ScheduledJob, JobLog } from "../types/scheduledJobUtils";

const API_BASE_URL = import.meta.env.VITE_APP_BASE_URL;

export const scheduledJobsApi = {
  getScheduledJobs: async (): Promise<ScheduledJob[]> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch scheduled jobs');
    }
    return data.data;
  },

  getScheduledJobById: async (id: number): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch scheduled job');
    }
    return data.data;
  },

  createScheduledJob: async (job: Partial<ScheduledJob>): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(job),
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to create scheduled job');
    }
    return data.data;
  },

  updateScheduledJob: async (id: number, job: Partial<ScheduledJob>): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(job),
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to update scheduled job');
    }
    return data.data;
  },

  deleteScheduledJob: async (id: number): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to delete scheduled job');
    }
  },

  toggleScheduledJobStatus: async (id: number): Promise<ScheduledJob> => {
    const response = await fetch(`${API_BASE_URL}/scheduled/jobs/${id}/toggle`, {
      method: 'PATCH',
    });
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to toggle job status');
    }
    return data.data;
  },

  executeJobManually: async (id: number): Promise<any> => {
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