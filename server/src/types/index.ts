export interface ScheduledJob {
    job_id: number;
    job_name: string;
    description: string;
    api_url: string;
    api_method: string;
    api_headers: any;
    api_body: any;
    cron_expression: string;
    active: boolean;
    next_job_id: number | null;
    retry_count: number;
    timeout_seconds: number;
    created_at: Date;
    updated_at: Date;
    last_run_at: Date | null;
    last_run_status: string | null;
}

export interface JobLog {
    log_id: number;
    job_id: number;
    reference_id: string;
    execution_time: Date;
    status: string;
    request_payload: any;
    response_data: any;
    response_status_code: number;
    error_message: string;
    execution_duration_ms: number;
    triggered_by: string;
    job_name?: string;
}

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface ScheduledJobsResponse extends ApiResponse<ScheduledJob[]> { }
