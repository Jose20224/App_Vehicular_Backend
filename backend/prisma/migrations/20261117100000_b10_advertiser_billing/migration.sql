CREATE TYPE public.ad_payment_status AS ENUM ('pending', 'proof_received', 'approved', 'rejected', 'cancelled');

CREATE TABLE public.ad_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, amount_usd numeric(12,2) NOT NULL,
  amount_nio_reference numeric(14,2) NOT NULL, currency varchar(3) NOT NULL DEFAULT 'USD',
  gateway varchar(40) NOT NULL DEFAULT 'manual_transfer', status public.ad_payment_status NOT NULL DEFAULT 'pending',
  bank_reference varchar(120), bank_reference_hash char(64), rejection_reason varchar(500),
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT, reviewed_at timestamptz,
  last_reminder_at timestamptz, last_overdue_reminder_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ad_payments_bank_reference_hash ON public.ad_payments(bank_reference_hash);
CREATE INDEX idx_ad_payments_owner_status_created ON public.ad_payments(user_id, status, created_at DESC);
CREATE INDEX idx_ad_payments_status_created ON public.ad_payments(status, created_at);

CREATE TABLE public.ad_payment_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES public.ad_payments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, object_key varchar(500) NOT NULL UNIQUE,
  content_type varchar(100) NOT NULL, size_bytes bigint NOT NULL, status varchar(24) NOT NULL DEFAULT 'upload_pending',
  uploaded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_payment_proofs_payment_created ON public.ad_payment_proofs(payment_id, created_at DESC);

CREATE SEQUENCE public.ad_invoice_number_seq START 1;
GRANT USAGE ON SEQUENCE public.ad_invoice_number_seq TO app_runtime;
CREATE TABLE public.ad_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL UNIQUE REFERENCES public.ad_payments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, invoice_number varchar(40) NOT NULL UNIQUE,
  amount_usd numeric(12,2) NOT NULL, amount_nio_reference numeric(14,2) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD', fiscal_format_status varchar(40) NOT NULL DEFAULT 'pending_dgi_confirmation',
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_invoices_owner_issued ON public.ad_invoices(user_id, issued_at DESC);

CREATE TABLE public.ad_payment_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES public.ad_payments(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT, action varchar(40) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_payment_audit_payment_created ON public.ad_payment_audit_logs(payment_id, created_at);
