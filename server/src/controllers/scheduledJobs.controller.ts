import { Request, Response } from 'express';
import { ApiResponse, ScheduledJob } from '../types/index.js';
import pool from '../config/database.js';

export const getScheduledJobs = async (_req: Request, res: Response<ApiResponse<ScheduledJob[]>>): Promise<void> => {
    try {
        const result = await pool.query(
            'SELECT * FROM scheduled_jobs ORDER BY job_id ASC'
        );
        
        res.json({
            success: true,
            data: result.rows,
            message: 'Scheduled jobs fetched successfully'
        });
    } catch (error) {
        console.error('Error fetching scheduled jobs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch scheduled jobs'
        });
    }
};

export const getScheduledJobById = async (req: Request<{ id: string }>, res: Response<ApiResponse<ScheduledJob>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.id);
        const result = await pool.query(
            'SELECT * FROM scheduled_jobs WHERE job_id = $1',
            [jobId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch scheduled job'
        });
    }
};

export const createScheduledJob = async (req: Request, res: Response<ApiResponse<ScheduledJob>>): Promise<void> => {
    try {
        const { job_name, description, api_url, api_method, cron_expression, active } = req.body;

        if (!job_name || !cron_expression) {
            res.status(400).json({
                success: false,
                message: 'job_name and cron_expression are required fields'
            });
            return;
        }

        const result = await pool.query(
            `INSERT INTO scheduled_jobs (job_name, description, api_url, api_method, cron_expression, active) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING *`,
            [job_name, description || '', api_url || '', api_method || 'GET', cron_expression, active !== undefined ? active : true]
        );

        res.status(201).json({
            success: true,
            data: result.rows[0],
            message: 'Scheduled job created successfully'
        });
    } catch (error) {
        console.error('Error creating scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create scheduled job'
        });
    }
};

export const updateScheduledJob = async (req: Request<{ id: string }>, res: Response<ApiResponse<ScheduledJob>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.id);
        const { job_name, description, api_url, api_method, cron_expression, active } = req.body;

        const result = await pool.query(
            `UPDATE scheduled_jobs 
             SET job_name = COALESCE($1, job_name),
                 description = COALESCE($2, description),
                 api_url = COALESCE($3, api_url),
                 api_method = COALESCE($4, api_method),
                 cron_expression = COALESCE($5, cron_expression),
                 active = COALESCE($6, active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE job_id = $7
             RETURNING *`,
            [job_name, description, api_url, api_method, cron_expression, active, jobId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        res.json({
            success: true,
            data: result.rows[0],
            message: 'Scheduled job updated successfully'
        });
    } catch (error) {
        console.error('Error updating scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update scheduled job'
        });
    }
};

export const deleteScheduledJob = async (req: Request<{ id: string }>, res: Response<ApiResponse<null>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.id);
        
        const result = await pool.query(
            'DELETE FROM scheduled_jobs WHERE job_id = $1 RETURNING job_id',
            [jobId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        res.json({
            success: true,
            message: 'Scheduled job deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete scheduled job'
        });
    }
};

export const toggleScheduledJobStatus = async (req: Request<{ id: string }>, res: Response<ApiResponse<ScheduledJob>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.id);
        
        const result = await pool.query(
            `UPDATE scheduled_jobs 
             SET active = NOT active,
                 updated_at = CURRENT_TIMESTAMP
             WHERE job_id = $1
             RETURNING *`,
            [jobId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        res.json({
            success: true,
            data: result.rows[0],
            message: `Scheduled job ${result.rows[0].active ? 'activated' : 'deactivated'} successfully`
        });
    } catch (error) {
        console.error('Error toggling scheduled job status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to toggle scheduled job status'
        });
    }
};

export const executeJobManually = async (req: Request<{ id: string }>, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.id);
        
        // Check if table exists first
        try {
            await pool.query('SELECT 1 FROM scheduled_jobs LIMIT 1');
        } catch (tableError) {
            console.error('Table scheduled_jobs does not exist:', tableError);
            res.status(500).json({
                success: false,
                error: 'Database table scheduled_jobs does not exist. Please initialize the database.'
            });
            return;
        }
        
        // Get job details
        const jobResult = await pool.query(
            'SELECT * FROM scheduled_jobs WHERE job_id = $1',
            [jobId]
        );

        if (jobResult.rows.length === 0) {
            // Log all available jobs for debugging
            const allJobsResult = await pool.query('SELECT job_id, job_name FROM scheduled_jobs ORDER BY job_id');
            console.log('Available jobs:', allJobsResult.rows);
            
            res.status(404).json({
                success: false,
                message: `Scheduled job with ID ${jobId} not found`
            });
            return;
        }

        const job = jobResult.rows[0];

        // Execute the job
        const startTime = Date.now();
        let logData: any = {
            job_id: jobId,
            triggered_by: 'manual',
            execution_time: new Date(),
        };

        try {
            const response = await fetch(job.api_url, {
                method: job.api_method || 'GET',
                headers: job.api_headers || {},
                body: job.api_body ? JSON.stringify(job.api_body) : undefined,
            });

            const duration = Date.now() - startTime;
            const responseData = await response.json().catch(() => null);

            logData = {
                ...logData,
                status: response.ok ? 'success' : 'failure',
                response_status_code: response.status,
                response_data: responseData,
                execution_duration_ms: duration,
            };

            // Update last run status
            await pool.query(
                'UPDATE scheduled_jobs SET last_run_at = $1, last_run_status = $2 WHERE job_id = $3',
                [new Date(), logData.status, jobId]
            );

        } catch (error: any) {
            const duration = Date.now() - startTime;
            logData = {
                ...logData,
                status: 'failure',
                error_message: error.message,
                execution_duration_ms: duration,
            };
        }

        // Insert log
        const logResult = await pool.query(
            `INSERT INTO job_execution_logs 
             (job_id, status, response_status_code, response_data, error_message, execution_duration_ms, triggered_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                logData.job_id,
                logData.status,
                logData.response_status_code || null,
                logData.response_data || null,
                logData.error_message || null,
                logData.execution_duration_ms,
                logData.triggered_by
            ]
        );

        res.json({
            success: true,
            data: {
                job: job,
                log: logResult.rows[0]
            },
            message: 'Job executed successfully'
        });
    } catch (error) {
        console.error('Error executing job manually:', error);
        console.error('Error details:', {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            jobId: req.params.id
        });
        res.status(500).json({
            success: false,
            error: 'Failed to execute job'
        });
    }
};