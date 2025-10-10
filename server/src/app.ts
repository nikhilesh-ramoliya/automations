import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import logsRoutes from './routes/logs.route.js';
import { ApiResponse } from './types/index.js';
import scheduledJobsRoutes from './routes/scheduledJobs.route.js';
import { initDatabase } from './db/init.js';
import pool from './config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

const corsOptions = {
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Requested-With', 'Accept'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// initDatabase().catch(console.error);

app.use('/api/v1/scheduled', scheduledJobsRoutes);
app.use('/api/v1', logsRoutes);

app.use(express.static(path.join(__dirname, '../../client/dist')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
});

app.use((req: Request, res: Response<ApiResponse<null>>, next: NextFunction) => {
    res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Endpoint not found'
    });
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    await pool.end();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});