export function JsonBlock({ value, maxHeight = 240 }: { value: unknown; maxHeight?: number }) {
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  })();
  return (
    <pre
      className="overflow-auto rounded-md bg-slate-900 p-3 text-[11px] leading-tight text-slate-100"
      style={{ maxHeight }}
    >
      {text}
    </pre>
  );
}
