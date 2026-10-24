// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";
import { cn } from "../lib/cn";

const FIELD =
  "rounded-md border border-border-soft bg-bg-1 px-2.5 text-[13px] text-text-0 outline-none placeholder:text-text-3 focus:border-border-strong";

type Common = { label: string; hideLabel?: boolean };

export function Input({
  label,
  hideLabel = false,
  id,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & Common) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className={hideLabel ? "sr-only" : "text-[12px] text-text-2"}>
        {label}
      </label>
      <input id={fieldId} className={cn(FIELD, "h-7", className)} {...rest} />
    </div>
  );
}

export function Textarea({
  label,
  hideLabel = false,
  id,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & Common) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className={hideLabel ? "sr-only" : "text-[12px] text-text-2"}>
        {label}
      </label>
      <textarea id={fieldId} className={cn(FIELD, "min-h-16 py-1.5", className)} {...rest} />
    </div>
  );
}
