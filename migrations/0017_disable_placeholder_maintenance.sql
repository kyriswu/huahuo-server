-- The bootstrap check only hashes a failed-task count; it performs no maintenance.
-- Stop its hourly writes while retaining its history and the scheduler mechanism.
-- This is one bounded configuration update, with no task/data deletion or grants.
UPDATE public.task_schedules SET enabled=false WHERE id='maintenance-check-v1' AND enabled;
