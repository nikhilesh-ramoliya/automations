import pool from '../config/database.js';

const schema = `
-- Create scheduled_jobs table
CREATE TABLE IF NOT EXISTS scheduled_jobs (
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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_active_jobs ON scheduled_jobs(active);
CREATE INDEX IF NOT EXISTS idx_next_job ON scheduled_jobs(next_job_id);

-- Create job_execution_logs table
CREATE TABLE IF NOT EXISTS job_execution_logs (
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

-- Create indexes for logs
CREATE INDEX IF NOT EXISTS idx_job_logs ON job_execution_logs(job_id, execution_time DESC);
CREATE INDEX IF NOT EXISTS idx_log_status ON job_execution_logs(status);
CREATE INDEX IF NOT EXISTS idx_reference_id ON job_execution_logs(reference_id);
`;

export const initDatabase = async () => {
    try {
        await pool.query(schema);
        console.log('Database schema initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
};