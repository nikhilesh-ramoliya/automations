import { Request, Response } from 'express';
import { scheduledJobs } from '../mock/mockScheduledJobs.js';
import { ApiResponse, ScheduledJob } from '../types/index.js';

export const getScheduledJobs = async (_req: Request, res: Response<ApiResponse<ScheduledJob[]>>): Promise<void> => {
    try {
        res.json({
            success: true,
            data: scheduledJobs,
            message: 'Scheduled jobs fetched successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch scheduled jobs'
        });
    }
};
