import type { ButtonHTMLAttributes } from "react";

const variants = {
  primary: "bg-teal text-teal-ink font-semibold hover:brightness-110",
  secondary: "bg-panel text-text border border-line hover:bg-panel-2",
  ghost: "bg-transparent text-soft hover:bg-panel-2",
  danger: "bg-danger text-white font-semibold hover:brightness-110",
} as const;

export type ButtonVariant = keyof typeof variants;

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={`min-h-[44px] rounded-[10px] px-4 text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...rest}
    />
  );
}
