import { Request, Response } from 'express';
import prisma from '../config/prisma.js';
import { ApiResponse } from '../types/index.js';

export const getAllLogs = async (req: Request, res: Response<ApiResponse<any[]>>): Promise<void> => {
    try {
        const { job_id, status, limit = '100', offset = '0' } = req.query;

        const where: any = {};
        
        if (job_id) {
            where.jobId = BigInt(job_id as string);
        }
        
        if (status) {
            where.status = status as string;
        }

        const logs = await prisma.jobExecutionLog.findMany({
            where,
            include: {
                job: {
                    select: {
                        jobName: true
                    }
                }
            },
            orderBy: { executionTime: 'desc' },
            take: parseInt(limit as string),
            skip: parseInt(offset as string)
        });

        const formattedLogs = logs.map((log: any) => ({
            log_id: log.logId,
            job_id: log.jobId,
            reference_id: log.referenceId,
            execution_time: log.executionTime,
            status: log.status,
            request_payload: log.requestPayload,
            response_data: log.responseData,
            response_status_code: log.responseStatusCode,
            error_message: log.errorMessage,
            execution_duration_ms: log.executionDurationMs,
            triggered_by: log.triggeredBy,
            job_name: log.job.jobName
        }));

        res.json({
            success: true,
            data: formattedLogs,
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

export const getLogById = async (req: Request<{ id: string }>, res: Response<ApiResponse<any>>): Promise<void> => {
    try {
        const logId = BigInt(req.params.id);
        
        const log = await prisma.jobExecutionLog.findUnique({
            where: { logId },
            include: {
                job: {
                    select: {
                        jobName: true
                    }
                }
            }
        });

        if (!log) {
            res.status(404).json({
                success: false,
                message: 'Log not found'
            });
            return;
        }

        const formattedLog = {
            log_id: log.logId,
            job_id: log.jobId,
            reference_id: log.referenceId,
            execution_time: log.executionTime,
            status: log.status,
            request_payload: log.requestPayload,
            response_data: log.responseData,
            response_status_code: log.responseStatusCode,
            error_message: log.errorMessage,
            execution_duration_ms: log.executionDurationMs,
            triggered_by: log.triggeredBy,
            job_name: log.job.jobName
        };

        res.json({
            success: true,
            data: formattedLog
        });
    } catch (error) {
        console.error('Error fetching log:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch log'
        });
    }
};

export const getLogsByJobId = async (req: Request<{ jobId: string }>, res: Response<ApiResponse<any[]>>): Promise<void> => {
    try {
        const jobId = BigInt(req.params.jobId);
        
        const logs = await prisma.jobExecutionLog.findMany({
            where: { jobId },
            include: {
                job: {
                    select: {
                        jobName: true
                    }
                }
            },
            orderBy: { executionTime: 'desc' },
            take: 100
        });

        const formattedLogs = logs.map((log: any) => ({
            log_id: log.logId,
            job_id: log.jobId,
            reference_id: log.referenceId,
            execution_time: log.executionTime,
            status: log.status,
            request_payload: log.requestPayload,
            response_data: log.responseData,
            response_status_code: log.responseStatusCode,
            error_message: log.errorMessage,
            execution_duration_ms: log.executionDurationMs,
            triggered_by: log.triggeredBy,
            job_name: log.job.jobName
        }));

        res.json({
            success: true,
            data: formattedLogs
        });
    } catch (error) {
        console.error('Error fetching logs by job:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch logs'
        });
    }
};