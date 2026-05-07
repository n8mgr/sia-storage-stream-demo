import { useEffect, useRef, useState } from 'react'

type Props = {
  open: boolean
  fileName: string
  onCancel: () => void
  onConfirm: (validDays: number) => void
}

const PRESETS: Array<{ days: number; label: string }> = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 365, label: '1 year' },
]

const MIN_DAYS = 1
const MAX_DAYS = 3650 // 10 years; SDK accepts any Date so this is just sanity.

/**
 * Modal that lets the user choose how long a share link should remain
 * valid. Built on the native <dialog> element so there's no new dep —
 * we just call showModal() / close() in a layout effect synced to the
 * `open` prop. The form's submit returns the chosen day count to the
 * caller; the caller does the actual sdk.shareObject + clipboard work.
 */
export function ShareDialog({ open, fileName, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [days, setDays] = useState<number>(7)

  // Sync the imperative <dialog> API with the open prop. Using showModal
  // (not show) so it's centered, modal, and gets the ::backdrop overlay.
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])

  // Reset the picker each time the dialog opens so previous selections
  // don't carry over to a different video.
  useEffect(() => {
    if (open) setDays(7)
  }, [open])

  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onCancel={onCancel}
      className="rounded-xl border border-neutral-200 backdrop:bg-black/40 backdrop:backdrop-blur-sm p-0 w-[min(92vw,28rem)]"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
            return
          }
          onConfirm(days)
        }}
        className="p-5 space-y-4"
      >
        <div>
          <h3 className="text-sm font-medium text-neutral-900">Share link</h3>
          <p
            className="text-xs text-neutral-500 mt-0.5 truncate"
            title={fileName}
          >
            {fileName}
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-1">
            Valid for
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const selected = days === p.days
              return (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => setDays(p.days)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    selected
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-600 mt-2">
            <span>or</span>
            <input
              type="number"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={days}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setDays(n)
              }}
              className="w-20 px-2 py-1 border border-neutral-300 rounded-md text-right tabular-nums"
            />
            <span>days</span>
          </label>
        </fieldset>

        <div className="text-xs text-neutral-500">
          Expires{' '}
          <span className="text-neutral-800 tabular-nums">
            {expires.toLocaleString()}
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!Number.isFinite(days) || days < MIN_DAYS}
            className="text-xs px-3 py-1.5 rounded-md bg-neutral-900 text-white hover:bg-neutral-800 disabled:bg-neutral-300 disabled:cursor-default transition-colors"
          >
            Copy link
          </button>
        </div>
      </form>
    </dialog>
  )
}
