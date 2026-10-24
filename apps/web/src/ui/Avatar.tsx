export function Avatar({
  name,
  agent = false,
  size = 36,
}: {
  name: string;
  agent?: boolean;
  size?: number;
}) {
  const shape = agent
    ? "rounded-[10px] border border-teal bg-agent text-teal-text"
    : "rounded-full bg-panel-2 text-soft";
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${shape}`}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
