import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/useAuthStore'
import { avatarValidationError } from '../lib/avatar.ts'
import Modal from './Modal'
import Avatar from './Avatar'
import ConfirmDialog from './ConfirmDialog'

interface Props { open: boolean; onClose: () => void }

export default function MyProfileModal({ open, onClose }: Props) {
  const { currentUser, uploadAvatar, removeAvatar } = useAuthStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  if (!currentUser) return null

  async function handleFile(file: File | null) {
    if (!file || !currentUser) return
    const validationError = avatarValidationError(file)
    if (validationError) { toast.error(validationError); return }
    setBusy(true)
    try {
      await uploadAvatar(currentUser.id, file)
      toast.success('Profile photo updated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Photo could not be uploaded.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove() {
    if (!currentUser) return
    setBusy(true)
    try {
      await removeAvatar(currentUser.id)
      toast.success('Profile photo removed.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Photo could not be removed.')
    } finally {
      setBusy(false)
      setConfirmRemove(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="My Profile">
      <div className="flex flex-col items-center gap-4 py-2">
        <Avatar path={currentUser.avatarPath} initials={currentUser.initials} sizeClass="size-24" />
        <div>
          <div className="text-center font-bold text-slate-900">{currentUser.name}</div>
          <div className="text-center text-xs text-slate-500">{currentUser.role} · @{currentUser.username}</div>
        </div>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={event => handleFile(event.target.files?.[0] || null)} />
        <div className="flex w-full gap-2">
          <button disabled={busy} onClick={() => inputRef.current?.click()} className="primary-button min-h-11 flex-1 disabled:opacity-60">
            {busy ? 'Uploading…' : currentUser.avatarPath ? 'Replace Photo' : 'Upload Photo'}
          </button>
          {currentUser.avatarPath && (
            <button disabled={busy} onClick={() => setConfirmRemove(true)} className="secondary-button min-h-11 flex-1">Remove</button>
          )}
        </div>
        <p className="text-center text-xs text-slate-400">JPG, PNG or WEBP · up to 2MB</p>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove Profile Photo"
        message="Remove your profile photo? You can upload a new one anytime."
        confirmLabel="Remove"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </Modal>
  )
}
