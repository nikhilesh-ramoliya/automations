CREATE TABLE scheduled_jobs (
    job_id BIGSERIAL PRIMARY KEY,
    job_name VARCHAR(255) NOT NULL,
    description TEXT,
    api_url TEXT,
    api_method VARCHAR(10) DEFAULT 'GET',
    api_headers JSONB,
    api_body JSONB,
    cron_expression VARCHAR(100) NOT NULL,
    active BOOLEAN DEFAULT true,
    next_job_id BIGINT REFERENCES scheduled_jobs(job_id),
    retry_count INTEGER DEFAULT 0,
    timeout_seconds INTEGER DEFAULT 30,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_run_at TIMESTAMP,
    last_run_status VARCHAR(50)
);