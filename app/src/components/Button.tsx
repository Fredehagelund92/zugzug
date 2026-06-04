import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";

/* Button — Tailwind conversion of the kit's `.ak-btn` (see reference/app-kit.css
   and the component gallery). Every colour, radius and font resolves to a brand
   token via the @theme alias in globals.css, so there are no hex literals here
   and no `dark:` variants — light/dark + accent flow through tokens.css. */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const base = cx(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
  "font-body font-semibold leading-none rounded-sm border border-transparent cursor-pointer",
  "transition-[background,border-color,transform,box-shadow] duration-[var(--ak-dur)] ease-[var(--ease)]",
  "active:translate-y-px focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]",
  "disabled:opacity-50 disabled:pointer-events-none",
);

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink border-accent shadow-[0_4px_16px_-12px_var(--accent)] hover:bg-accent-hover hover:shadow-[0_8px_24px_-8px_var(--accent)]",
  secondary: "bg-transparent text-ink border-line-2 hover:bg-hover",
  ghost: "bg-transparent text-ink-2 hover:bg-hover hover:text-ink",
  danger: "bg-danger text-white border-danger hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-[11px] py-1.5",
  md: "text-[13px] px-4 py-2.5",
  lg: "text-[15px] px-[22px] py-[13px]",
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button className={cx(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}
