import { Router } from 'express';
import { 
    getScheduledJobs, 
    getScheduledJobById,
    createScheduledJob,
    updateScheduledJob,
    deleteScheduledJob,
    toggleScheduledJobStatus,
    executeJobManually
} from '../controllers/scheduledJobs.controller.js';

const router = Router();

router.get('/jobs', getScheduledJobs);
router.get('/jobs/:id', getScheduledJobById);
router.post('/jobs', createScheduledJob);
router.put('/jobs/:id', updateScheduledJob);
router.delete('/jobs/:id', deleteScheduledJob);
router.patch('/jobs/:id/toggle', toggleScheduledJobStatus);
router.post('/jobs/:id/execute', executeJobManually);

export default router;