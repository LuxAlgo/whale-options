/*
  The LuxAlgo symbol, inline so the dashboard ships with zero external
  assets. Renders in currentColor to follow the header's text color.
  The name and mark are trademarks of LuxAlgo Global, LLC; see
  TRADEMARKS.md at the repository root.
*/
export function LuxAlgoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40.8 37" className={className} aria-label="LuxAlgo" role="img">
      <path
        fill="currentColor"
        d="M36.217 34.646l4.139-7.231L25.868 2.108 11.381 27.415h8.279l6.209-10.845z"
      />
      <path
        fill="currentColor"
        d="M31.042 29.224 8.267 29.22 24.833.3h-8.277L0 29.216l4.137 7.237h31.045z"
      />
    </svg>
  );
}
