export interface ScheduledJob {
  jobId: number | string;
  jobName: string;
  description: string | null;
  apiUrl: string | null;
  apiMethod: string;
  apiHeaders: any;
  apiBody: any;
  cronExpression: string;
  active: boolean;
  nextJobId: number | string | null;
  retryCount: number;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

export interface JobLog {
  log_id: number;
  job_id: number;
  reference_id: string;
  execution_time: string;
  status: string;
  request_payload: any;
  response_data: any;
  response_status_code: number;
  error_message: string;
  execution_duration_ms: number;
  triggered_by: string;
  job_name?: string;
}