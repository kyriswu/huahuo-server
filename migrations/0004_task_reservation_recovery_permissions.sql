-- Scheduler can release an existing task reservation in the task-recovery
-- transaction. No account/grant creation, charge settlement, data backfill,
-- schema rewrite or physical foreign key. Existing binaries remain compatible.
-- Only the columns used by reservation release are writable; migrations remain
-- transactional and repeatable under the existing migration ledger.
GRANT UPDATE (status, updated_at) ON public.credit_reservations TO huahuo_scheduler;
GRANT UPDATE (available_credits, reserved_credits) ON public.credit_lots TO huahuo_scheduler;
GRANT INSERT (entry_id, user_id, reservation_id, lot_id, entry_type, credits)
  ON public.credit_ledger_entries TO huahuo_scheduler;
