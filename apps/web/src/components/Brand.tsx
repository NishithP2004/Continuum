export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Continuum">
      <img className="brand__mark" src="/continuum-mark.svg" alt="" />
      {!compact && <span className="brand__name">Continuum</span>}
    </div>
  );
}
