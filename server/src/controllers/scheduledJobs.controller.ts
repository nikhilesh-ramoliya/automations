import { Request, Response } from 'express';
import prisma from '../config/prisma.js';
import { ApiResponse } from '../types/index.js';

export const getScheduledJobs = async (_req: Request, res: Response<ApiResponse<any[]>>): Promise<void> => {
    try {
        const jobs = await prisma.scheduledJob.findMany({
            orderBy: { jobId: 'asc' }
        });
        
        res.json({
            success: true,
            data: jobs,
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

export const getScheduledJobById = async (req: Request<{ id: string }>, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const jobId = BigInt(req.params.id);
        
        const job = await prisma.scheduledJob.findUnique({
            where: { jobId }
        });

        if (!job) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        res.json({
            success: true,
            data: job
        });
    } catch (error) {
        console.error('Error fetching scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch scheduled job'
        });
    }
};

export const createScheduledJob = async (req: Request, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const { job_name, description, api_url, api_method, api_headers, api_body, cron_expression, active, retry_count, timeout_seconds } = req.body;

        if (!job_name || !cron_expression) {
            res.status(400).json({
                success: false,
                message: 'job_name and cron_expression are required fields'
            });
            return;
        }

        const newJob = await prisma.scheduledJob.create({
            data: {
                jobName: job_name,
                description: description || null,
                apiUrl: api_url || null,
                apiMethod: api_method || 'GET',
                apiHeaders: api_headers || null,
                apiBody: api_body || null,
                cronExpression: cron_expression,
                active: active !== undefined ? active : true,
                retryCount: retry_count || 0,
                timeoutSeconds: timeout_seconds || 30
            }
        });

        res.status(201).json({
            success: true,
            data: newJob,
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

export const updateScheduledJob = async (req: Request<{ id: string }>, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const jobId = BigInt(req.params.id);
        const { job_name, description, api_url, api_method, api_headers, api_body, cron_expression, active, retry_count, timeout_seconds } = req.body;

        const updatedJob = await prisma.scheduledJob.update({
            where: { jobId },
            data: {
                ...(job_name && { jobName: job_name }),
                ...(description !== undefined && { description }),
                ...(api_url !== undefined && { apiUrl: api_url }),
                ...(api_method && { apiMethod: api_method }),
                ...(api_headers !== undefined && { apiHeaders: api_headers }),
                ...(api_body !== undefined && { apiBody: api_body }),
                ...(cron_expression && { cronExpression: cron_expression }),
                ...(active !== undefined && { active }),
                ...(retry_count !== undefined && { retryCount: retry_count }),
                ...(timeout_seconds !== undefined && { timeoutSeconds: timeout_seconds }),
                updatedAt: new Date()
            }
        });

        res.json({
            success: true,
            data: updatedJob,
            message: 'Scheduled job updated successfully'
        });
    } catch (error: any) {
        if (error.code === 'P2025') {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }
        console.error('Error updating scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update scheduled job'
        });
    }
};

export const deleteScheduledJob = async (req: Request<{ id: string }>, res: Response<ApiResponse<null>>): Promise<void> => {
    try {
        const jobId = BigInt(req.params.id);
        
        await prisma.scheduledJob.delete({
            where: { jobId }
        });

        res.json({
            success: true,
            message: 'Scheduled job deleted successfully'
        });
    } catch (error: any) {
        if (error.code === 'P2025') {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }
        console.error('Error deleting scheduled job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete scheduled job'
        });
    }
};

export const toggleScheduledJobStatus = async (req: Request<{ id: string }>, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const jobId = BigInt(req.params.id);
        
        const job = await prisma.scheduledJob.findUnique({
            where: { jobId }
        });

        if (!job) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        const updatedJob = await prisma.scheduledJob.update({
            where: { jobId },
            data: {
                active: !job.active,
                updatedAt: new Date()
            }
        });

        res.json({
            success: true,
            data: updatedJob,
            message: `Scheduled job ${updatedJob.active ? 'activated' : 'deactivated'} successfully`
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
        const jobId = BigInt(req.params.id);
        
        const job = await prisma.scheduledJob.findUnique({
            where: { jobId }
        });

        if (!job) {
            res.status(404).json({
                success: false,
                message: 'Scheduled job not found'
            });
            return;
        }

        const startTime = Date.now();
        let logData: any = {
            jobId: job.jobId,
            triggeredBy: 'manual',
        };

        try {
            const fetchOptions: RequestInit = {
                method: job.apiMethod || 'GET',
            };

            if (job.apiHeaders) {
                fetchOptions.headers = job.apiHeaders as HeadersInit;
            }

            if (job.apiBody && (job.apiMethod === 'POST' || job.apiMethod === 'PUT' || job.apiMethod === 'PATCH')) {
                fetchOptions.body = JSON.stringify(job.apiBody);
            }

            const response = await fetch(job.apiUrl || '', fetchOptions);
            const duration = Date.now() - startTime;
            const responseData = await response.json().catch(() => null);

            logData = {
                ...logData,
                status: response.ok ? 'success' : 'failure',
                responseStatusCode: response.status,
                responseData: responseData,
                executionDurationMs: duration,
            };

            await prisma.scheduledJob.update({
                where: { jobId },
                data: {
                    lastRunAt: new Date(),
                    lastRunStatus: logData.status,
                    updatedAt: new Date()
                }
            });

        } catch (error: any) {
            const duration = Date.now() - startTime;
            logData = {
                ...logData,
                status: 'failure',
                errorMessage: error.message,
                executionDurationMs: duration,
            };
        }

        const log = await prisma.jobExecutionLog.create({
            data: {
                jobId: logData.jobId,
                status: logData.status,
                responseStatusCode: logData.responseStatusCode || null,
                responseData: logData.responseData || null,
                errorMessage: logData.errorMessage || null,
                executionDurationMs: logData.executionDurationMs,
                triggeredBy: logData.triggeredBy
            }
        });

        res.json({
            success: true,
            data: {
                job: job,
                log: log
            },
            message: 'Job executed successfully'
        });
    } catch (error) {
        console.error('Error executing job manually:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to execute job'
        });
    }
};