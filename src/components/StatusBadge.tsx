import type { ShipmentStatus, PaymentStatus } from '../types'
import { shipmentStatusLabel } from '../types'

const STATUS_STYLES: Record<ShipmentStatus, string> = {
  RECEIVED: 'bg-blue-50/80 text-blue-700 ring-blue-200/80',
  PACKED: 'bg-amber-50/80 text-amber-700 ring-amber-200/80',
  DISPATCHED: 'bg-orange-50/80 text-orange-700 ring-orange-200/80',
  ON_TRANSIT: 'bg-sky-50/80 text-sky-700 ring-sky-200/80',
  IN_CUSTOMS: 'bg-violet-50/80 text-violet-700 ring-violet-200/80',
  ARRIVED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  DELIVERED: 'bg-green-50 text-green-800 ring-green-200',
}

const PAYMENT_STYLES: Record<PaymentStatus, string> = {
  'Unpaid': 'bg-red-50 text-red-700 ring-red-200',
  'Partially Paid': 'bg-amber-50 text-amber-700 ring-amber-200',
  'Paid': 'bg-emerald-50 text-emerald-700 ring-emerald-200',
}

interface Props {
  status: ShipmentStatus
  size?: 'sm' | 'md'
}

interface PaymentProps {
  status: PaymentStatus
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'sm' }: Props) {
  const styles = STATUS_STYLES[status]
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ring-1 ring-inset ${styles} ${padding}`}>
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {shipmentStatusLabel(status)}
    </span>
  )
}

export function PaymentBadge({ status, size = 'sm' }: PaymentProps) {
  const styles = PAYMENT_STYLES[status]
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
  return (
    <span className={`inline-flex items-center rounded-full font-semibold ring-1 ring-inset ${styles} ${padding}`}>
      {status}
    </span>
  )
}
