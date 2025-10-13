CREATE TABLE job_execution_logs (
    log_id BIGSERIAL PRIMARY KEY,
    job_id BIGINT NOT NULL REFERENCES scheduled_jobs(job_id) ON DELETE CASCADE,
    reference_id UUID DEFAULT gen_random_uuid(),
    execution_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL,
    request_payload JSONB,
    response_data JSONB,
    response_status_code INTEGER,
    error_message TEXT,
    execution_duration_ms INTEGER,
    triggered_by VARCHAR(100) DEFAULT 'cron'
);