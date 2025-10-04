export interface ScheduledJob {
    job_id: number;
    job_name: string;
    description: string;
    api: string;
    cron: string;
    active: boolean;
}

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface ScheduledJobsResponse extends ApiResponse<ScheduledJob[]> { }
