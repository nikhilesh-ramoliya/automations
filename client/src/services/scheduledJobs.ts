export interface ScheduledJob {
  job_id: number;
  job_name: string;
  description: string;
  api: string;
  cron: string;
  active: boolean;
}

const API_BASE_URL = import.meta.env.VITE_APP_BASE_URL;

export const scheduledJobsApi = {
  getScheduledJobs: async (): Promise<ScheduledJob[]> => {
    const response = await fetch(`${API_BASE_URL}/jobs`);
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to fetch scheduled jobs');
    }
    return data.data;
  },
};