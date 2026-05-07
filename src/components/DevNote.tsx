import type { ReactNode } from 'react'

export function DevNote({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="border-l-4 border-amber-500 bg-amber-950/40 rounded-r-lg p-4 space-y-1">
      <p className="text-amber-300 text-xs font-semibold uppercase tracking-wider">
        Developer Note
      </p>
      <p className="text-amber-200 text-sm font-medium">{title}</p>
      <div className="text-amber-200/80 text-xs leading-relaxed">
        {children}
      </div>
    </div>
  )
}
