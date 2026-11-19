
export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="ui-panel p-6">
      <p className="text-sm font-medium leading-[18px] text-muted">{label}</p>
      <p className="mt-3 text-[30px] font-normal leading-9 text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}
