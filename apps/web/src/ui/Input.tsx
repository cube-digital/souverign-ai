import { type InputHTMLAttributes, useId } from "react";

export function Input({
  label,
  hideLabel = false,
  id,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hideLabel?: boolean }) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-xs text-muted"}>
        {label}
      </label>
      <input
        id={inputId}
        className={`min-h-[44px] rounded-[10px] border border-line bg-panel-2 px-3 text-text outline-none focus:border-teal ${className}`}
        {...rest}
      />
    </div>
  );
}
