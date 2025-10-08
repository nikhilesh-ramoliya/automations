import pool from '../config/database.js';

const schema = `
-- Insert sample data
INSERT INTO scheduled_jobs (job_name, description, api, cron, active) VALUES
('Fetch Leads', 'Fetch new company leads from CRM and store them in database every day at 8 AM', 'https://internal-api.example.com/fetch-leads', '0 8 * * *', true),
('Craft Email Content', 'Use GPT API to craft personalized email content for new leads every day at 9 AM', 'https://internal-api.example.com/gpt-email-craft', '0 9 * * *', true),
('Send Marketing Emails', 'Send crafted emails to companies via SMTP or email API every day at 10 AM', 'https://internal-api.example.com/send-emails', '0 10 * * *', true),
('Follow-up Reminder', 'Check responses from previous emails and schedule follow-up emails every day at 3 PM', 'https://internal-api.example.com/follow-up', '0 15 * * *', true),
('Weekly Analytics Report', 'Generate a weekly report of emails sent, opened, and responses every Monday at 11 AM', 'https://internal-api.example.com/weekly-report', '0 11 * * 1', true)
ON CONFLICT DO NOTHING;
`;

export const initDatabase = async () => {
    try {
        await pool.query(schema);
        console.log('Database schema initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
};