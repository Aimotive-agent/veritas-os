import type React from 'react'
import { cn } from '../../lib/cn.ts'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'sm' | 'md' | 'icon' | 'icon-sm'

export interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: Variant
  size?: Size
}

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong font-medium',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3',
  ghost: 'text-fg-2 hover:text-fg hover:bg-white/5',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25',
  outline: 'text-fg-2 hover:text-fg hairline hover:bg-white/5'
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px] rounded-sm gap-1.5',
  md: 'h-8 px-3 text-[13px] rounded-md gap-2',
  icon: 'size-8 rounded-md',
  'icon-sm': 'size-7 rounded-sm'
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    />
  )
}
