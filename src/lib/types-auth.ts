export interface Profile {
  id: string;
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

export interface PickerApplication {
  id: string;
  user_id: string;
  note: string | null;
  /** Public URL in the rider-photos bucket, snapshot submitted with the application. */
  photo_url: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}