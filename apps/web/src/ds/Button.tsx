// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/cn";

const VARIANT = {
  default: "border-border-soft bg-bg-1 text-text-0 hover:bg-bg-2",
  primary: "border-text-0 bg-text-0 text-bg-0 font-semibold hover:opacity-90",
  ghost: "border-transparent bg-transparent text-text-1 hover:bg-bg-2 hover:text-text-0",
  danger: "border-danger bg-transparent text-danger hover:bg-bg-2",
} as const;
const SIZE = {
  sm: "h-6 px-2 text-[12px]",
  md: "h-7 px-3 text-[13px]",
  lg: "h-9 px-4 text-[13px]",
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});

export function IconButton({
  label,
  className,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-6 w-6 cursor-pointer place-items-center rounded-md text-text-2 hover:bg-bg-2 hover:text-text-0",
        className,
      )}
      {...rest}
    />
  );
}
