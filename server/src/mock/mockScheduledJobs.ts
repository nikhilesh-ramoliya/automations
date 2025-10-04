import { ScheduledJob } from '../types/index.js';

export const scheduledJobs: ScheduledJob[] = [
  {
    job_id: 1,
    job_name: 'Fetch Leads',
    description: 'Fetch new company leads from CRM and store them in database every day at 8 AM',
    api: 'https://internal-api.example.com/fetch-leads',
    cron: '0 8 * * *',
    active: true
  },
  {
    job_id: 2,
    job_name: 'Craft Email Content',
    description: 'Use GPT API to craft personalized email content for new leads every day at 9 AM',
    api: 'https://internal-api.example.com/gpt-email-craft',
    cron: '0 9 * * *',
    active: true
  },
  {
    job_id: 3,
    job_name: 'Send Marketing Emails',
    description: 'Send crafted emails to companies via SMTP or email API every day at 10 AM',
    api: 'https://internal-api.example.com/send-emails',
    cron: '0 10 * * *',
    active: true
  },
  {
    job_id: 4,
    job_name: 'Follow-up Reminder',
    description: 'Check responses from previous emails and schedule follow-up emails every day at 3 PM',
    api: 'https://internal-api.example.com/follow-up',
    cron: '0 15 * * *',
    active: true
  },
  {
    job_id: 5,
    job_name: 'Weekly Analytics Report',
    description: 'Generate a weekly report of emails sent, opened, and responses every Monday at 11 AM',
    api: 'https://internal-api.example.com/weekly-report',
    cron: '0 11 * * 1',
    active: true
  }
];
