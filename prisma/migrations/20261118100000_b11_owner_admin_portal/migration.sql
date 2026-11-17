ALTER TABLE public.workshops ADD COLUMN is_preloaded boolean NOT NULL DEFAULT false;
ALTER TABLE public.assistance_providers ADD COLUMN is_preloaded boolean NOT NULL DEFAULT false;

CREATE TABLE public.business_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workshop_id uuid UNIQUE REFERENCES public.workshops(id) ON DELETE RESTRICT,
  assistance_provider_id uuid UNIQUE REFERENCES public.assistance_providers(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL DEFAULT 'pending', evidence varchar(1000), rejection_reason varchar(500),
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_business_claim_target CHECK ((workshop_id IS NOT NULL)::int + (assistance_provider_id IS NOT NULL)::int = 1),
  CONSTRAINT ck_business_claim_status CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX idx_business_claims_status_created ON public.business_claims(status, created_at);

CREATE TABLE public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action varchar(180) NOT NULL, resource_type varchar(80) NOT NULL, resource_id varchar(100),
  before_state jsonb NOT NULL DEFAULT '{}', after_state jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_audit_actor_created ON public.admin_audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_resource_created ON public.admin_audit_logs(resource_type, resource_id, created_at DESC);
