CREATE TYPE public.ad_campaign_status AS ENUM ('draft', 'pending_payment', 'active', 'paused', 'expired', 'cancelled');
CREATE TYPE public.ad_billing_period AS ENUM ('monthly', 'quarterly', 'annual');
CREATE TYPE public.ad_metric_event_type AS ENUM ('impression', 'click', 'call', 'whatsapp', 'route');

CREATE TABLE public.ad_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description varchar(500),
  price_usd numeric(12,2) NOT NULL CHECK (price_usd >= 0),
  duration_days smallint NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  quarterly_discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (quarterly_discount_percent BETWEEN 0 AND 100),
  annual_discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (annual_discount_percent BETWEEN 0 AND 100),
  nio_per_usd numeric(14,8) NOT NULL DEFAULT 36.7 CHECK (nio_per_usd > 0),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_plans_active ON public.ad_plans(is_active);

CREATE TABLE public.ad_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description varchar(300),
  max_active_campaigns integer NOT NULL DEFAULT 20 CHECK (max_active_campaigns > 0),
  max_active_per_department integer NOT NULL DEFAULT 3 CHECK (max_active_per_department > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ad_slots_active ON public.ad_slots(is_active);

INSERT INTO public.ad_slots (code, name, description, max_active_campaigns, max_active_per_department) VALUES
  ('featured_banner', 'Banner destacado', 'Banner promocionado en portada.', 12, 2),
  ('sponsored_result', 'Resultado patrocinado', 'Resultado promocionado en búsquedas.', 30, 3),
  ('map_pin', 'Pin destacado en mapa', 'Pin promocionado en mapas.', 30, 3),
  ('premium_profile', 'Perfil premium', 'Perfil de negocio destacado.', 20, 3);

CREATE TABLE public.ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  ad_plan_id uuid NOT NULL REFERENCES public.ad_plans(id) ON DELETE RESTRICT,
  ad_slot_id uuid NOT NULL REFERENCES public.ad_slots(id) ON DELETE RESTRICT,
  workshop_id uuid REFERENCES public.workshops(id) ON DELETE RESTRICT,
  assistance_provider_id uuid REFERENCES public.assistance_providers(id) ON DELETE RESTRICT,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  municipality_id uuid,
  campaign_name varchar(120) NOT NULL,
  billing_period public.ad_billing_period NOT NULL DEFAULT 'monthly',
  price_usd numeric(12,2) NOT NULL CHECK (price_usd >= 0),
  price_nio_reference numeric(14,2) NOT NULL CHECK (price_nio_reference >= 0),
  fx_rate_nio_per_usd numeric(14,8) NOT NULL CHECK (fx_rate_nio_per_usd > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status public.ad_campaign_status NOT NULL DEFAULT 'draft',
  sponsored boolean NOT NULL DEFAULT false,
  payment_confirmed_at timestamptz,
  payment_confirmed_by_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  payment_due_at timestamptz,
  expiry_warning_sent_at timestamptz,
  last_served_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ad_campaign_target_exactly_one CHECK ((workshop_id IS NULL) <> (assistance_provider_id IS NULL)),
  CONSTRAINT ck_ad_campaign_dates CHECK (ends_at > starts_at),
  CONSTRAINT ck_ad_campaign_paid_before_active CHECK (status <> 'active' OR (payment_confirmed_at IS NOT NULL AND sponsored)),
  CONSTRAINT fk_ad_campaign_workshop_owner FOREIGN KEY (workshop_id, user_id) REFERENCES public.workshops(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ad_campaign_provider_owner FOREIGN KEY (assistance_provider_id, user_id) REFERENCES public.assistance_providers(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ad_campaign_municipality_department FOREIGN KEY (municipality_id, department_id) REFERENCES public.municipalities(id, department_id) ON DELETE RESTRICT
);
CREATE INDEX idx_ad_campaigns_owner_status_created ON public.ad_campaigns(user_id, status, created_at DESC);
CREATE INDEX idx_ad_campaigns_schedule ON public.ad_campaigns(status, starts_at, ends_at);
CREATE INDEX idx_ad_campaigns_slot_department_status ON public.ad_campaigns(ad_slot_id, department_id, status);
CREATE INDEX idx_ad_campaigns_workshop ON public.ad_campaigns(workshop_id);
CREATE INDEX idx_ad_campaigns_provider ON public.ad_campaigns(assistance_provider_id);

CREATE TABLE public.ad_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type public.ad_metric_event_type NOT NULL,
  window_start timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ad_metrics_dedupe_window UNIQUE (ad_campaign_id, user_id, event_type, window_start)
);
CREATE INDEX idx_ad_metrics_campaign_created ON public.ad_metrics(ad_campaign_id, created_at);
CREATE INDEX idx_ad_metrics_user_created ON public.ad_metrics(user_id, created_at);
