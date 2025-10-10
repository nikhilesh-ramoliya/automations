import { Router } from 'express';
import { getAllLogs, getLogById, getLogsByJobId } from '../controllers/logs.controller.js';

const router = Router();

router.get('/logs', getAllLogs);
router.get('/logs/:id', getLogById);
router.get('/jobs/:jobId/logs', getLogsByJobId);

export default router;