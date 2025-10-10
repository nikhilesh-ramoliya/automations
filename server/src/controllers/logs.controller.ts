import { Request, Response } from 'express';
import pool from '../config/database.js';
import { ApiResponse } from '../types/index.js';

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

export const getAllLogs = async (req: Request, res: Response<ApiResponse<JobLog[]>>): Promise<void> => {
    try {
        const { job_id, status, limit = 100, offset = 0 } = req.query;

        let query = `
            SELECT l.*, j.job_name 
            FROM job_execution_logs l
            LEFT JOIN scheduled_jobs j ON l.job_id = j.job_id
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (job_id) {
            query += ` AND l.job_id = $${paramIndex}`;
            params.push(parseInt(job_id as string));
            paramIndex++;
        }

        if (status) {
            query += ` AND l.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        query += ` ORDER BY l.execution_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit as string), parseInt(offset as string));

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows,
            message: 'Logs fetched successfully'
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch logs'
        });
    }
};

export const getLogById = async (req: Request<{ id: string }>, res: Response<ApiResponse<JobLog>>): Promise<void> => {
    try {
        const logId = parseInt(req.params.id);
        
        const result = await pool.query(
            `SELECT l.*, j.job_name 
             FROM job_execution_logs l
             LEFT JOIN scheduled_jobs j ON l.job_id = j.job_id
             WHERE l.log_id = $1`,
            [logId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Log not found'
            });
            return;
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching log:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch log'
        });
    }
};

export const getLogsByJobId = async (req: Request<{ jobId: string }>, res: Response<ApiResponse<JobLog[]>>): Promise<void> => {
    try {
        const jobId = parseInt(req.params.jobId);
        
        const result = await pool.query(
            `SELECT l.*, j.job_name 
             FROM job_execution_logs l
             LEFT JOIN scheduled_jobs j ON l.job_id = j.job_id
             WHERE l.job_id = $1
             ORDER BY l.execution_time DESC
             LIMIT 100`,
            [jobId]
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching logs by job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch logs'
        });
    }
};