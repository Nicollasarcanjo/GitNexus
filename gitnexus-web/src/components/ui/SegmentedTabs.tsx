import type { ReactNode } from 'react';
import { cn } from './cn';

export interface SegmentedTabOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedTabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedTabOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}

/** Compact pill-style tab list for switching between a few views. */
export const SegmentedTabs = <T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedTabsProps<T>) => (
  <div
    role="tablist"
    aria-label={label}
    className={cn('flex gap-1 rounded-lg border border-border-subtle bg-elevated p-1', className)}
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="tab"
        aria-selected={option.value === value}
        onClick={() => onChange(option.value)}
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
          option.value === value
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-hover hover:text-text-primary',
        )}
      >
        {option.icon}
        {option.label}
      </button>
    ))}
  </div>
);
