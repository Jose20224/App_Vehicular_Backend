export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
export interface Profile {
  id: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  role: string;
}
export interface Vehicle {
  id: string;
  plate: string;
  brand: string;
  model: string;
  model_year: number;
  vehicle_type: string;
  alias: string | null;
  color: string | null;
  mileage_km: number | null;
  photo_url?: string | null;
}
export interface DocumentRecord {
  id: string;
  title: string;
  document_type: string;
  valid_from: string | null;
  valid_until: string | null;
  status: string | null;
  file_status: string;
  insurance_policy_id?: string | null;
}
export interface Policy {
  id: string;
  policy_number: string;
  insurer: { name: string } | null;
  other_insurer_name: string | null;
  valid_from: string;
  valid_until: string;
  currency: string;
  premium: string | null;
  deductible: string | null;
  claims_phone: string | null;
  document: DocumentRecord | null;
}
export interface Collection<T> {
  items: T[];
  count?: number;
  has_more?: boolean;
  next_cursor?: string | null;
}
export interface CatalogItem {
  id: string;
  name: string;
  phone?: string;
  phone_e164?: string;
}
export interface Workshop {
  id: string;
  slug: string;
  name: string;
  description?: string;
  address_reference_text?: string;
  address?: string;
  distance_meters?: number | null;
  is_open_now?: boolean;
  sponsored?: boolean;
  patrocinado?: boolean;
  rating_average?: number | string | null;
  rating_count?: number;
  latitude?: number | null;
  longitude?: number | null;
  photos?: { url: string }[];
  services?: { id: string; name: string; estimated_price?: string }[];
  service_offerings?: {
    id: string;
    name: string;
    price_min: number;
    price_max: number;
    currency: string;
    price_status: string;
  }[];
  weekly_schedule?: Record<string, unknown>;
}
export interface Review {
  id: string;
  rating: number;
  comment: string | null;
  author?: { display_name: string };
  created_at: string;
  owner_reply?: { body: string } | string | null;
}
export interface Contact {
  id: string;
  name: string;
  phone_e164?: string;
  phone?: string;
  relationship_label?: string;
  is_primary: boolean;
}
export interface Assistance {
  id: string;
  status: string;
  issue_description: string;
  address_reference_text: string;
  created_at: string;
  provider?: { name: string } | null;
}
export interface AppNotification {
  id: string;
  title: string;
  description?: string;
  body?: string;
  read_at?: string | null;
  created_at: string;
}
export interface Preferences {
  enabled_offsets: number[];
  preferred_time: string;
  push_enabled: boolean;
  local_enabled: boolean;
  in_app_enabled: boolean;
}
export interface Ad {
  id?: string;
  campaign_id?: string;
  title?: string;
  headline?: string;
  description?: string;
  expires_at: string;
  patrocinado: boolean;
  target_url?: string;
  workshop_id?: string;
}
