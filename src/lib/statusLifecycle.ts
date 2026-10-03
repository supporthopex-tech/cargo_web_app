import type { ShipmentStatus, StatusTransitionInput, UserRole } from '../types/index.ts'
import { STATUS_ORDER } from '../types/index.ts'

export function nextShipmentStatus(current: ShipmentStatus): ShipmentStatus | null {
  const index = STATUS_ORDER.indexOf(current)
  return index >= 0 && index < STATUS_ORDER.length - 1 ? STATUS_ORDER[index + 1] : null
}

export function isCorrection(current: ShipmentStatus, requested: ShipmentStatus): boolean {
  return nextShipmentStatus(current) !== requested
}

export function validateStatusTransition(
  current: ShipmentStatus,
  input: StatusTransitionInput,
  role: UserRole,
): string[] {
  const errors: string[] = []
  if (input.status === current) errors.push('Choose a different status.')
  const correction = isCorrection(current, input.status)
  if (correction && !['Admin', 'Manager'].includes(role)) {
    errors.push('Only an Admin or Manager can skip or reverse lifecycle stages.')
  }
  if (correction && !input.correctionReason?.trim()) {
    errors.push('Reason for status correction is required.')
  }
  if (input.status === 'IN_CUSTOMS' && !input.customsType) {
    errors.push('Customs type is required.')
  }
  if (input.status === 'DELIVERED') {
    if (!input.delivery?.recipientName.trim()) errors.push('Recipient name is required.')
    if (!input.delivery?.deliveredAt) errors.push('Collection or delivery date is required.')
  }
  return errors
}

export function timelineState(current: ShipmentStatus, step: ShipmentStatus): 'complete' | 'current' | 'future' {
  const currentIndex = STATUS_ORDER.indexOf(current)
  const stepIndex = STATUS_ORDER.indexOf(step)
  if (stepIndex < currentIndex) return 'complete'
  if (stepIndex === currentIndex) return 'current'
  return 'future'
}
