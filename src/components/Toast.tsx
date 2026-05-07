import { useToastStore } from '../stores/toast'

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="animate-fade-in px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-300 shadow-lg"
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
