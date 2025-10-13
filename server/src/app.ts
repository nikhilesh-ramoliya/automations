import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import scheduledJobsRoutes from './routes/scheduledJobs.route.js';
import logsRoutes from './routes/logs.route.js';
import { ApiResponse } from './types/index.js';
import prisma from './config/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const corsOptions = {
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Requested-With', 'Accept'],
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Test database connection
prisma.$connect()
    .then(() => console.log('Connected to database via Prisma'))
    .catch((error: Error) => console.error('Database connection failed:', error));

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

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    await prisma.$disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    await prisma.$disconnect();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});