export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" style={{ fill: 'var(--accent)' }} />
      <path
        d="M11.5 12.5a4.5 4.5 0 1 1 6.6 4c-1.3.7-2.1 1.6-2.1 3.2"
        fill="none"
        stroke="#fff"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <circle cx="16" cy="24" r="1.9" fill="#fff" />
    </svg>
  );
}
