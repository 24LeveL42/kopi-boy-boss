// Must stay in sync with the rider-photos bucket in the Partner app's
// docs/supabase-schema.sql (sections 23 + 25) — riders and pickers both upload there.
const APPLICANT_PHOTO_BUCKET = "rider-photos";

/**
 * `photo_url` is free text the applicant wrote, so only trust it when it
 * points into their own `<user_id>/` folder of our public bucket — anything
 * else could be someone else's photo (defeating the ID check) or a tracking
 * pixel on a third-party host.
 */
function isOwnApplicantPhoto(url: string, userId: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  if (!base) return false;
  return url.startsWith(`${base}/storage/v1/object/public/${APPLICANT_PHOTO_BUCKET}/${userId}/`);
}

/** Photo submitted with a rider/picker application, for HQ to verify identity before approving. */
export function ApplicantPhoto({ url, userId, name }: { url: string | null; userId: string; name: string }) {
  const box = "flex h-20 w-20 shrink-0 items-center justify-center rounded-xl text-center text-[10px] leading-tight";

  if (!url) {
    return (
      <div className={box} style={{ background: "var(--kb-cream)", color: "var(--kb-ink-soft)" }}>
        No photo submitted
      </div>
    );
  }

  if (!isOwnApplicantPhoto(url, userId)) {
    return (
      <div className={box} style={{ background: "rgba(239,68,68,0.15)", color: "#DC2626" }}>
        Unrecognised photo link
      </div>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size" className="shrink-0">
      {/* Remote Supabase Storage URL, not configured for next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Photo submitted by ${name}`}
        data-testid="applicant-photo"
        className="h-20 w-20 rounded-xl object-cover"
      />
    </a>
  );
}
