/** "📞 phone · ✉️ email" for admin-only partner/applicant cards. Renders nothing if neither is on file. */
export function ContactLine({ phone, email }: { phone: string | null | undefined; email: string | null | undefined }) {
  if (!phone && !email) return null;
  return (
    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
      {phone && (
        <a href={`tel:${phone.replace(/\s+/g, "")}`} className="hover:underline">
          📞 {phone}
        </a>
      )}
      {phone && email && " · "}
      {email && (
        <a href={`mailto:${email}`} className="break-all hover:underline">
          ✉️ {email}
        </a>
      )}
    </p>
  );
}
