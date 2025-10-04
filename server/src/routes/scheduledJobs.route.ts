import { Router } from 'express';
import { getScheduledJobs } from '../controllers/scheduledJobs.controller.js';

const router = Router();

router.get('/jobs', getScheduledJobs);

export default router;