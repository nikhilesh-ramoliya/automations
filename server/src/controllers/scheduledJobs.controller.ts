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
