export interface Profile {
  id: string;
  /** "picker" is a retired role: the DB may still hold it, but Boss no longer lists or approves pickers. */
  role: "customer" | "cook" | "rider" | "picker" | "admin";
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CookApplication {
  id: string;
  user_id: string;
  business_name: string;
  business_type: string | null;
  description: string | null;
  neighbourhood: string | null;
  paynow_uen: string | null;
  /** ACRA registration number; required for every business type except Home Cook (Partner schema section 26). */
  business_uen: string | null;
  /** Pickup address + 6-digit postal code given at sign-up (Partner schema section 28). */
  business_address?: string | null;
  postal_code?: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export interface RiderApplication {
  id: string;
  user_id: string;
  vehicle_type: string | null;
  license_plate: string | null;
  /** Public URL in the rider-photos bucket, snapshot submitted with the application. */
  photo_url: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}