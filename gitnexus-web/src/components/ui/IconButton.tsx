import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type IconButtonTone = 'default' | 'accent' | 'ghost';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  tone?: IconButtonTone;
  size?: 'sm' | 'md';
}

const TONES: Record<IconButtonTone, string> = {
  default:
    'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary',
  accent: 'border-accent/30 bg-accent/20 text-accent hover:bg-accent/30',
  ghost: 'border-transparent text-text-muted hover:bg-hover hover:text-text-primary',
};

/** Square button holding a single icon. */
export const IconButton = ({
  label,
  tone = 'default',
  size = 'md',
  className,
  type = 'button',
  ...props
}: IconButtonProps) => (
  <button
    type={type}
    title={label}
    aria-label={label}
    className={cn(
      'flex cursor-pointer items-center justify-center border transition-colors',
      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
      size === 'md' ? 'h-9 w-9 rounded-md' : 'h-7 w-7 rounded',
      TONES[tone],
      className,
    )}
    {...props}
  />
);
