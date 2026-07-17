interface SuperAdminBadgeProps {
  className?: string;
}

/** Consistent super-admin pill used across the admin console.
 *  Uses the violet tint to signal an elevated/system-level role,
 *  distinct from the rose accent used by the workspace RoleBadge. */
export function SuperAdminBadge({ className }: SuperAdminBadgeProps) {
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-px font-mono text-[9px] uppercase tracking-widest${className ? ` ${className}` : ""}`}
      style={{
        borderColor: "color-mix(in srgb, var(--tint-violet) 50%, transparent)",
        color: "var(--tint-violet)",
        background: "color-mix(in srgb, var(--tint-violet) 12%, transparent)",
      }}
    >
      Super-admin
    </span>
  );
}
