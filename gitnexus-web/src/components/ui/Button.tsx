import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders the "on" look for toggle buttons and sets `aria-pressed`. */
  active?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-white hover:bg-accent/90',
  secondary:
    'border-border-subtle bg-surface text-text-secondary hover:bg-hover hover:text-text-primary',
  ghost: 'border-transparent text-text-secondary hover:bg-hover hover:text-text-primary',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 rounded px-2 text-xs',
  md: 'h-9 gap-1.5 rounded-md px-3 text-sm',
  lg: 'h-11 gap-2 rounded-lg px-4 text-sm',
};

/** Text button (optionally with a leading icon as a child). */
export const Button = ({
  variant = 'secondary',
  size = 'md',
  active,
  fullWidth,
  className,
  type = 'button',
  ...props
}: ButtonProps) => (
  <button
    type={type}
    aria-pressed={active}
    className={cn(
      'inline-flex cursor-pointer items-center justify-center border font-medium transition-colors',
      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50',
      SIZES[size],
      active ? VARIANTS.primary : VARIANTS[variant],
      fullWidth && 'w-full',
      className,
    )}
    {...props}
  />
);
