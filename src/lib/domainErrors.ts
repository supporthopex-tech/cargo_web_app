function technicalErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '')
  const candidate = error as Record<string, unknown>
  return [candidate.code, candidate.message, candidate.details, candidate.hint]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
}

export function paymentErrorMessage(error: unknown): string {
  const text = technicalErrorText(error)
  if (text.includes('payment exceeds') || text.includes('outstanding invoice balance')) {
    return 'This payment is greater than the current outstanding balance. Refresh the shipment and try again.'
  }
  if (text.includes('invoice must be posted')) {
    return 'The shipment invoice must be finalized before a payment can be recorded.'
  }
  if (text.includes('currency must match')) {
    return 'The payment currency must match the shipment invoice currency.'
  }
  if (text.includes('receipt_number') || text.includes('receipt number') || text.includes('23505')) {
    return 'A receipt number conflict occurred. Please retry; a new receipt number will be generated safely.'
  }
  if (text.includes('idempotency key')) {
    return 'This payment submission was already used with different details. Close the form and start a new payment.'
  }
  if (text.includes('active staff session') || text.includes('jwt') || text.includes('permission')) {
    return 'Your staff session cannot record payments. Sign in again or contact an administrator.'
  }
  if (text.includes('shipment not found') || text.includes('no rows') || text.includes('pgrst116')) {
    return 'This shipment is no longer available. Refresh the page and select it again.'
  }
  return 'The payment could not be recorded. No receipt was printed. Please retry.'
}

export function statusErrorMessage(error: unknown): string {
  const text = technicalErrorText(error)
  if (text.includes('shipment not found') || text.includes('no rows') || text.includes('pgrst116')) {
    return 'This shipment is no longer available. Refresh the page before updating its status.'
  }
  if (text.includes('already in status')) {
    return 'The shipment was already moved to that status. Refresh the page to see the latest timeline.'
  }
  if (text.includes('active staff session') || text.includes('jwt') || text.includes('permission')) {
    return 'Your staff session cannot update this status. Sign in again or contact an administrator.'
  }
  if (text.includes('packing list box')) return 'Packing must start before this shipment can be marked as packed.'
  if (text.includes('admin or manager')) return 'Only an Admin or Manager can skip or reverse lifecycle stages.'
  if (text.includes('could not be read back') || text.includes('confirmation failed')) {
    return 'The status change could not be confirmed and was rolled back. Refresh and try again.'
  }
  return 'The shipment status could not be updated. The page was left unchanged.'
}

export function extraChargeErrorMessage(error: unknown): string {
  const text = technicalErrorText(error)
  if (text.includes('supplier payment') && text.includes('company expense')) {
    return 'Supplier Payment must be recorded as a company expense.'
  }
  if (text.includes('custom label')) return 'Enter a custom label for the “Other” charge type.'
  if (text.includes('currency must match')) return 'The charge currency must match the shipment invoice currency.'
  if (text.includes('posted payments') && text.includes('exceed')) {
    return 'This change would reduce Total Due below payments already posted. Review or refund the payment first.'
  }
  if (text.includes('manager or admin') || text.includes('permission')) {
    return 'Only a Manager or Admin can change cargo charges.'
  }
  if (text.includes('shipment not found') || text.includes('charge not found')) {
    return 'The shipment or charge is no longer available. Refresh the page and try again.'
  }
  return 'The cargo charge could not be saved. No financial totals were changed.'
}
