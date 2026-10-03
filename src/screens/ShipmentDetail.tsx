import { useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore, canAccess } from '../store/useAuthStore'
import { CARGO_EXTRA_CHARGE_LABELS, CARGO_EXTRA_CHARGE_TYPES, DEFAULT_CHARGE_DIRECTION, formatAmount, shipmentStatusLabel, STATUS_ORDER } from '../types'
import type { CargoExtraCharge, CargoExtraChargeType, ChargeDirection, CustomsType, ShipmentStatus } from '../types'
import { StatusBadge, PaymentBadge } from '../components/StatusBadge'
import Modal from '../components/Modal'
import ConfirmDialog from '../components/ConfirmDialog'
import { QRCodeSVG } from 'qrcode.react'
import { printShippingLabel, printPaymentReceipt, printShipmentReceipt } from '../lib/pdf'
import { itemQrUrl, printItemStickers } from '../lib/itemStickers'
import { allocatedQuantity, availableQuantity, formatPackingQuantity, shipmentPackingSummary } from '../lib/packing'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import { isCorrection, nextShipmentStatus, timelineState, validateStatusTransition } from '../lib/statusLifecycle'
import { shipmentFinancialSummary } from '../lib/accounting'

interface Props { shipmentId: string; onNavigate: (s: Screen, id?: string) => void }

export default function ShipmentDetail({ shipmentId, onNavigate }: Props) {
  const { shipments, customers, packingLists, packingAllocations, settings, expenses, addPayment, deletePayment, updateShipmentStatus, setShipmentHold, deleteShipment, refundPayment, voidShipment, unvoidShipment, getPaymentsForShipment, getExtraChargesForShipment, addCargoExtraCharge, updateCargoExtraCharge, deleteCargoExtraCharge } = useAppStore()
  const currentUser = useAuthStore(s => s.currentUser)
  const canDeleteShipment = canAccess(currentUser?.role, 'shipment.delete')
  const canVoidShipment = canAccess(currentUser?.role, 'shipment.void')
  const canManageExtraCharges = canAccess(currentUser?.role, 'extra_charges')

  const shipment = shipments.find(s => s.id === shipmentId) || shipments[0]
  const customer = customers.find(c => c.id === shipment?.customerId)
  const shipmentPayments = getPaymentsForShipment(shipmentId)
  const shipmentExtraCharges = getExtraChargesForShipment(shipmentId)
  // Client-side mirror of guard_and_log_shipment_delete() in
  // supabase/migrations/20260819120000_shipment_delete_and_payment_refund.sql —
  // a shipment can only be hard-deleted while it has no real warehouse
  // activity (no packing allocation, no return, no delivery confirmation);
  // Void is the only path once any of that exists. Payments/invoice no
  // longer block delete on their own — delete_shipment() detaches payment
  // history instead of destroying it (see the 3-option dialog below).
  const hasPackingHistory = shipment ? shipment.items.some(item => allocatedQuantity(item.id, packingAllocations, packingLists) > 0) : false
  const canSafelyHardDelete = !hasPackingHistory && shipmentExtraCharges.length === 0
  const postedPayments = shipmentPayments.filter(p => p.status === 'POSTED')

  const [paymentModal, setPaymentModal] = useState(false)
  const [statusModal, setStatusModal] = useState(false)
  const [holdModal, setHoldModal] = useState(false)
  const [deleteStep, setDeleteStep] = useState<'closed' | 'simple' | 'choice' | 'keep' | 'refund'>('closed')
  const [deleteReason, setDeleteReason] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [voidModal, setVoidModal] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)
  const [qrModal, setQrModal] = useState(false)
  const [itemQrCode, setItemQrCode] = useState<string | null>(null)
  const [stickerCopies, setStickerCopies] = useState(1)
  const [payForm, setPayForm] = useState({ amount: '', method: 'Bank Transfer', date: new Date().toISOString().slice(0,10), note: '' })
  const [payErrors, setPayErrors] = useState<Record<string, string>>({})
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentAttemptKey, setPaymentAttemptKey] = useState<string>(() => crypto.randomUUID())
  const paymentSubmitGuard = useRef(false)
  const [statusForm, setStatusForm] = useState({
    status: '' as ShipmentStatus | '',
    location: '',
    publicNote: '',
    internalNote: '',
    customsType: '' as CustomsType | '',
    customsLocation: '',
    dispatchReference: '',
    correctionReason: '',
    recipientName: '',
    recipientPhone: '',
    deliveredAt: new Date().toISOString().slice(0, 16),
    deliveryNotes: '',
  })
  const [holdReason, setHoldReason] = useState('')
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [statusSaving, setStatusSaving] = useState(false)
  const statusSubmitGuard = useRef(false)
  const [chargeModal, setChargeModal] = useState(false)
  const [editingCharge, setEditingCharge] = useState<CargoExtraCharge | null>(null)
  const [chargeDeleteTarget, setChargeDeleteTarget] = useState<CargoExtraCharge | null>(null)
  const [chargeForm, setChargeForm] = useState({
    chargeType: 'pickup' as CargoExtraChargeType,
    customLabel: '',
    direction: 'billable_to_customer' as ChargeDirection,
    amount: '',
    chargeDate: new Date().toISOString().slice(0, 10),
    note: '',
    paymentMethod: 'Bank Transfer',
  })
  const [chargeErrors, setChargeErrors] = useState<Record<string, string>>({})
  const [chargeBusy, setChargeBusy] = useState(false)
  const [chargeAttemptKey, setChargeAttemptKey] = useState<string>(() => crypto.randomUUID())
  const chargeSubmitGuard = useRef(false)
  const chargeDeleteGuard = useRef(false)

  if (!shipment) return <div className="p-8 text-slate-400">Shipment not found.</div>

  const invoiceCurrency = shipment.invoiceCurrency ?? shipment.currency
  const baseInvoiceTotal = shipment.invoiceAmount ?? shipment.totalAmount
  const linkedExistingExpenses = expenses
    .filter(expense => expense.shipmentId === shipment.id && expense.status === 'POSTED' && expense.currency === invoiceCurrency)
    .reduce((sum, expense) => sum + expense.amount, 0)
  const financial = shipmentFinancialSummary(baseInvoiceTotal, shipment.amountPaid, shipmentExtraCharges, linkedExistingExpenses)
  const invoiceTotal = financial.totalDue
  const paymentStatus = financial.paymentStatus
  const balance = financial.balance
  const paidPct = invoiceTotal > 0 ? Math.min(100, Math.round((shipment.amountPaid / invoiceTotal) * 100)) : 0
  const packingSummary = shipmentPackingSummary(shipment.items, packingAllocations, packingLists)
  const nextStatus = nextShipmentStatus(shipment.status)
  const canCorrect = currentUser?.role === 'Admin' || currentUser?.role === 'Manager'
  const availableTransitions = canCorrect
    ? STATUS_ORDER.filter(status => status !== shipment.status)
    : nextStatus ? [nextStatus] : []

  function openPaymentModal() {
    setPaymentAttemptKey(crypto.randomUUID())
    setPayErrors({})
    setPaymentModal(true)
  }

  async function handlePaymentSave() {
    const e: Record<string, string> = {}
    const amt = parseFloat(payForm.amount)
    if (!amt || amt <= 0) e.amount = 'Valid amount required'
    if (amt > balance + 0.01) e.amount = `Max payable: ${formatAmount(balance, invoiceCurrency)}`
    if (!payForm.date) e.date = 'Date required'
    if (Object.keys(e).length) { setPayErrors(e); return }
    if (paymentSubmitGuard.current) return
    paymentSubmitGuard.current = true
    setPaymentSaving(true)
    try {
      const payment = await addPayment({
        shipmentId: shipment.id,
        amount: amt,
        currency: invoiceCurrency,
        method: payForm.method,
        date: payForm.date,
        note: payForm.note,
        idempotencyKey: paymentAttemptKey,
      })
      toast.success(`Payment ${payment.receiptNumber} recorded!`)
      // Re-fetch from the store instead of using the stale shipmentPayments closure
      // captured at render time (which predates this payment) — addPayment() already
      // committed the DB-confirmed row into the store before resolving, so this call
      // reflects authoritative totals. Do not .concat(payment) on top of it.
      try {
        await printPaymentReceipt(payment, shipment, customer, settings, getPaymentsForShipment(shipment.id), getExtraChargesForShipment(shipment.id))
      } catch (printError) {
        console.error('[ShipmentDetail] receipt printing failed after payment save:', printError)
        toast.error('Payment was saved, but the receipt could not be printed. Use the receipt row to try again.')
      }
      setPaymentModal(false)
      setPayForm({ amount: '', method: 'Bank Transfer', date: new Date().toISOString().slice(0,10), note: '' })
      setPayErrors({})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record payment.')
    } finally {
      setPaymentSaving(false)
      paymentSubmitGuard.current = false
    }
  }

  function openAddCharge() {
    setEditingCharge(null)
    setChargeAttemptKey(crypto.randomUUID())
    setChargeForm({
      chargeType: 'pickup',
      customLabel: '',
      direction: DEFAULT_CHARGE_DIRECTION.pickup,
      amount: '',
      chargeDate: new Date().toISOString().slice(0, 10),
      note: '',
      paymentMethod: 'Bank Transfer',
    })
    setChargeErrors({})
    setChargeModal(true)
  }

  function openEditCharge(charge: CargoExtraCharge) {
    setEditingCharge(charge)
    setChargeAttemptKey(charge.idempotencyKey ?? crypto.randomUUID())
    setChargeForm({
      chargeType: charge.chargeType,
      customLabel: charge.customLabel ?? '',
      direction: charge.direction,
      amount: String(charge.amount),
      chargeDate: charge.chargeDate,
      note: charge.note ?? '',
      paymentMethod: charge.paymentMethod ?? 'Bank Transfer',
    })
    setChargeErrors({})
    setChargeModal(true)
  }

  async function handleChargeSave() {
    const errors: Record<string, string> = {}
    const amount = Number(chargeForm.amount)
    if (!Number.isFinite(amount) || amount <= 0) errors.amount = 'Enter an amount greater than zero'
    if (!chargeForm.chargeDate) errors.chargeDate = 'Charge date is required'
    if (chargeForm.chargeType === 'other' && !chargeForm.customLabel.trim()) errors.customLabel = 'Custom label is required'
    if (chargeForm.chargeType === 'supplier_payment' && chargeForm.direction !== 'company_expense') errors.direction = 'Supplier Payment must be a company expense'
    if (Object.keys(errors).length > 0) { setChargeErrors(errors); return }
    if (chargeSubmitGuard.current) return
    chargeSubmitGuard.current = true
    setChargeBusy(true)
    const payload = {
      shipmentId: shipment.id,
      chargeType: chargeForm.chargeType,
      customLabel: chargeForm.chargeType === 'other' ? chargeForm.customLabel.trim() : undefined,
      direction: chargeForm.direction,
      amount,
      currency: invoiceCurrency,
      chargeDate: chargeForm.chargeDate,
      note: chargeForm.note.trim() || undefined,
      paymentMethod: chargeForm.direction === 'company_expense' ? chargeForm.paymentMethod : undefined,
      idempotencyKey: chargeAttemptKey,
    }
    try {
      if (editingCharge) {
        await updateCargoExtraCharge(editingCharge.id, payload, 'Cargo extra charge edited from shipment detail.')
        toast.success('Cargo charge updated')
      } else {
        await addCargoExtraCharge(payload)
        toast.success('Cargo charge added')
      }
      setChargeModal(false)
      setEditingCharge(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save cargo charge.')
    } finally {
      setChargeBusy(false)
      chargeSubmitGuard.current = false
    }
  }

  async function handleChargeDelete() {
    if (!chargeDeleteTarget || chargeDeleteGuard.current) return
    chargeDeleteGuard.current = true
    setChargeBusy(true)
    try {
      await deleteCargoExtraCharge(chargeDeleteTarget.id, 'Cargo extra charge deleted from shipment detail.')
      toast.success('Cargo charge deleted')
      setChargeDeleteTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete cargo charge.')
    } finally {
      setChargeBusy(false)
      chargeDeleteGuard.current = false
    }
  }

  async function handleStatusUpdate() {
    const input = statusForm.status ? {
      status: statusForm.status,
      location: statusForm.location,
      publicNote: statusForm.publicNote,
      internalNote: statusForm.internalNote,
      customsType: statusForm.customsType || undefined,
      customsLocation: statusForm.customsLocation,
      dispatchReference: statusForm.dispatchReference,
      correctionReason: statusForm.correctionReason,
      delivery: statusForm.status === 'DELIVERED' ? {
        recipientName: statusForm.recipientName,
        recipientPhone: statusForm.recipientPhone,
        deliveredAt: statusForm.deliveredAt ? new Date(statusForm.deliveredAt).toISOString() : '',
        notes: statusForm.deliveryNotes,
      } : undefined,
    } : null
    const e: Record<string, string> = {}
    if (!input) e.status = 'Select a status'
    if (!statusForm.location.trim()) e.location = 'Location required'
    if (input && currentUser) {
      for (const message of validateStatusTransition(shipment.status, input, currentUser.role)) {
        if (message.includes('correction')) e.correctionReason = message
        else if (message.includes('Customs')) e.customsType = message
        else if (message.includes('Recipient')) e.recipientName = message
        else if (message.includes('date')) e.deliveredAt = message
        else e.status = message
      }
    }
    if (Object.keys(e).length) { setStatusErrors(e); return }
    if (statusSubmitGuard.current) return
    statusSubmitGuard.current = true
    setStatusSaving(true)
    try {
      await updateShipmentStatus(shipment.id, input!)
      toast.success(`Status updated to “${shipmentStatusLabel(input!.status)}”`)
      setStatusModal(false)
      setStatusForm(form => ({ ...form, status: '', location: '', publicNote: '', internalNote: '', customsType: '', customsLocation: '', dispatchReference: '', correctionReason: '', recipientName: '', recipientPhone: '', deliveryNotes: '' }))
      setStatusErrors({})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status.')
    } finally {
      setStatusSaving(false)
      statusSubmitGuard.current = false
    }
  }

  async function handleHoldChange() {
    if (!shipment.isOnHold && !holdReason.trim()) return
    try {
      await setShipmentHold(shipment.id, !shipment.isOnHold, holdReason)
      toast.success(shipment.isOnHold ? 'Shipment hold released' : 'Shipment placed on hold')
      setHoldModal(false)
      setHoldReason('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Hold status could not be changed.')
    }
  }

  function openDelete() {
    setDeleteReason('')
    setDeleteStep(shipmentPayments.length > 0 ? 'choice' : 'simple')
  }

  async function handleDeleteKeepFinancial() {
    if (!deleteReason.trim()) return
    setDeleteBusy(true)
    try {
      await deleteShipment(shipment.id, deleteReason)
      toast.success('Shipment deleted. Payment history was kept for accounting.')
      onNavigate('dashboard')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete shipment.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleDeleteNoPayments() {
    if (!deleteReason.trim()) return
    setDeleteBusy(true)
    try {
      await deleteShipment(shipment.id, deleteReason)
      toast.success('Shipment deleted')
      onNavigate('dashboard')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete shipment.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleRefundAndDelete() {
    if (!deleteReason.trim()) return
    setDeleteBusy(true)
    try {
      for (const payment of postedPayments) {
        await refundPayment(payment.id, deleteReason)
      }
      await deleteShipment(shipment.id, deleteReason)
      toast.success(`${postedPayments.length} payment${postedPayments.length === 1 ? '' : 's'} refunded, shipment deleted.`)
      onNavigate('dashboard')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refund and delete shipment.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleVoid() {
    if (!voidReason.trim()) return
    setVoidBusy(true)
    try {
      await voidShipment(shipment.id, voidReason)
      toast.success('Shipment voided.')
      setVoidModal(false)
      setVoidReason('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to void shipment.')
    } finally {
      setVoidBusy(false)
    }
  }

  async function handleUnvoid() {
    try {
      await unvoidShipment(shipment.id)
      toast.success('Shipment restored from voided.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore shipment.')
    }
  }

  async function handlePrintLabel() { await printShippingLabel(shipment, customer, settings); toast.success('Label generated!') }
  async function handlePrintReceipt() { await printShipmentReceipt(shipment, customer, shipmentPayments, settings, shipmentExtraCharges); toast.success('Receipt generated!') }
  function handlePrintAllItemStickers() {
    const opened = printItemStickers(shipment.items.map(item => ({ item, shipment, customer, copies: 1 })), settings)
    opened ? toast.success(`${shipment.items.length} item stickers prepared.`) : toast.error('The print window was blocked. Allow pop-ups and try again.')
  }
  function handlePrintItemSticker(itemCode: string, copies = 1) {
    const item = shipment.items.find(candidate => candidate.itemCode === itemCode)
    if (!item) return
    const opened = printItemStickers([{ item, shipment, customer, copies }], settings)
    opened ? toast.success(`${copies} sticker${copies === 1 ? '' : 's'} prepared.`) : toast.error('The print window was blocked. Allow pop-ups and try again.')
  }

  return (
    <div className="min-h-full bg-transparent">
      {/* Sub-header */}
      <div className="border-b border-slate-200 bg-white px-3 py-4 sm:px-6">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <button onClick={() => onNavigate('dashboard')} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition-colors"><ArrowLeftIcon /> Shipments</button>
          <span className="text-slate-200">/</span>
          <span className="font-mono text-sm font-semibold text-navy-700">{shipment.trackingNumber}</span>
          <StatusBadge status={shipment.status} size="md" />
          {shipment.isOnHold && <span className="inline-flex rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-700 ring-1 ring-red-200">On Hold</span>}
          {shipment.voidedAt && <span className="inline-flex rounded-full bg-slate-800 px-2.5 py-1 text-xs font-bold text-white ring-1 ring-slate-900" title={shipment.voidedReason}>Voided</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {balance > 0 && (
            <button onClick={openPaymentModal} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-cargo-500 px-3 text-xs font-semibold text-white">
              <PlusCircleIcon /> Record Payment
            </button>
          )}
          <button onClick={handlePrintLabel} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"><PrintIcon /> Print Label</button>
          <button onClick={handlePrintReceipt} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"><PrintIcon /> Print Receipt</button>
          {shipment.items.length > 0 && <button onClick={handlePrintAllItemStickers} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-orange-200 px-3 text-xs font-semibold text-orange-700 hover:bg-orange-50"><PrintIcon /> Print All {shipment.items.length} Stickers</button>}
          <button onClick={() => setStatusModal(true)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"><EditIcon /> Update Status</button>
          <button onClick={() => setHoldModal(true)} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${shipment.isOnHold ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50' : 'border-red-200 text-red-600 hover:bg-red-50'}`}>{shipment.isOnHold ? 'Release Hold' : 'Place On Hold'}</button>
          <button onClick={() => setQrModal(true)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"><QrIcon /> QR Code</button>
          <button onClick={() => onNavigate('public-tracking', shipmentId)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:ml-auto"><ExternalIcon /> Customer View</button>
          {canDeleteShipment && canSafelyHardDelete && !shipment.voidedAt && (
            <button onClick={openDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-red-100 text-red-500 rounded-lg hover:bg-red-50" title="Delete"><TrashIcon /></button>
          )}
          {canVoidShipment && !canSafelyHardDelete && !shipment.voidedAt && (
            <button onClick={() => setVoidModal(true)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50">Void Shipment</button>
          )}
          {canVoidShipment && shipment.voidedAt && (
            <button onClick={handleUnvoid} className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-emerald-200 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Restore Voided Shipment</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 p-3 sm:p-6 xl:grid-cols-3">
        {shipment.isOnHold && <div className="xl:col-span-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span className="font-bold">Shipment On Hold.</span> {shipment.holdReason || 'Contact a Manager for details.'}</div>}
        {/* Panel A */}
        <div className="space-y-4">
          <PanelCard title="Shipment Information" icon={<BoxIcon />}>
            <div className="flex items-center gap-3 p-3 rounded-xl mb-4" style={{ backgroundColor: 'rgb(12,28,53)' }}>
              <div className="flex-1 text-center">
                <div className="text-xs text-slate-400 mb-1">Origin</div>
                <div className="text-xs font-semibold text-white leading-snug">{shipment.origin}</div>
              </div>
              <div className="flex flex-col items-center gap-1 px-2">
                <div className="size-2 rounded-full" style={{ backgroundColor: 'rgb(249,115,22)' }} />
                <div className="w-16 h-px bg-slate-600 relative">
                  <div className="absolute inset-y-0 left-0 transition-all" style={{ width: `${paidPct}%`, backgroundColor: 'rgb(249,115,22)' }} />
                </div>
                <PlaneIconSm />
              </div>
              <div className="flex-1 text-center">
                <div className="text-xs text-slate-400 mb-1">Destination</div>
                <div className="text-xs font-semibold text-white leading-snug">{shipment.destinationCity}, TZ</div>
              </div>
            </div>
            <div className="space-y-2.5 text-sm">
              <InfoRow label="Customer" value={customer?.company || customer?.name || shipment.customerNameSnapshot || '—'} />
              <InfoRow label="Description" value={shipment.description} />
              <InfoRow label="Service" value={shipment.serviceType} />
              <InfoRow label="Category" value={shipment.cargoCategory} />
              <InfoRow label="Rate" value={shipment.shippingRate} />
              <InfoRow label="Created" value={shipment.createdAt} />
              {shipment.notes && <InfoRow label="Notes" value={shipment.notes} />}
              <div className="grid gap-2 pt-1 sm:grid-cols-3">
                <MetricChip label="Weight" value={`${shipment.weightKg.toLocaleString()} kg`} />
                <MetricChip label="Volume" value={`${shipment.volumeCbm} cbm`} />
                <MetricChip label="Pieces" value={`${shipment.pcs} pcs`} />
              </div>
              {shipment.items.length > 0 && (
                <div className="pt-3 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Cargo Items</div>
                    <PackingSummaryBadge state={packingSummary.state} />
                  </div>
                  {packingSummary.totals.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {packingSummary.totals.map(total => (
                        <div key={total.unit} className="rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600">
                          <span className="font-semibold text-slate-800">{formatPackingQuantity(total.packed)}/{formatPackingQuantity(total.total)} {total.unit}</span> packed
                          {total.remaining > 0 && <span className="text-slate-400"> · {formatPackingQuantity(total.remaining)} remaining</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-2">
                    {shipment.items.map(item => {
                      const allocated = allocatedQuantity(item.id, packingAllocations, packingLists)
                      const available = availableQuantity(item, packingAllocations, packingLists)
                      return <div key={item.id || item.itemNumber} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="font-semibold text-sm text-slate-800">{item.itemNumber}. {item.description}</div><div className="font-mono text-[11px] font-semibold text-orange-700 mt-0.5">{item.itemCode || 'Item code pending'}</div><div className="text-xs text-slate-500 mt-1">Original {formatPackingQuantity(item.quantity)} {item.unit} · Allocated {formatPackingQuantity(allocated)} · Available {formatPackingQuantity(available)}</div></div></div>
                        {item.itemCode && <div className="mt-2 grid gap-2 sm:grid-cols-3"><button onClick={() => { setItemQrCode(item.itemCode!); setStickerCopies(1) }} className="secondary-button min-h-11 text-xs">View QR</button><button onClick={() => handlePrintItemSticker(item.itemCode!)} className="secondary-button min-h-11 text-xs">Print Sticker</button><button onClick={() => onNavigate('item-detail', item.itemCode)} className="secondary-button min-h-11 text-xs">Item Details</button></div>}
                      </div>
                    })}
                  </div>
                </div>
              )}
            </div>
          </PanelCard>
        </div>

        {/* Panel B */}
        <div>
          <PanelCard title="Financial Summary" icon={<CurrencyIcon />}>
            <div className="space-y-3">
              {shipment.baseAmountUsd != null && (
                <div className="grid grid-cols-2 gap-2">
                  <MetricChip label="Pricing Unit" value={shipment.pricingUnit || '—'} />
                  <MetricChip label="Standard Rate" value={`USD ${shipment.standardRateUsd ?? '—'}`} />
                  <MetricChip label="Applied Rate" value={`USD ${shipment.appliedRateUsd ?? '—'}`} />
                  <MetricChip label="Base Amount" value={formatAmount(shipment.baseAmountUsd, 'USD')} />
                </div>
              )}
              {shipment.rateOverridden && <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800">Authorized rate override applied. Internal reason is retained in the audit trail.</div>}
              {shipment.exchangeRateDate && (
                <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs text-blue-800">
                  <div className="font-semibold mb-1">Exchange-rate snapshot · {shipment.exchangeRateDate}</div>
                  <div>USD/TZS: {shipment.usdToTzsRateUsed ?? '—'} · USD/AED: {shipment.usdToAedRateUsed ?? '—'}</div>
                  <div className="mt-1">Invoice {shipment.invoiceNumber}: {formatAmount(invoiceTotal, invoiceCurrency)}</div>
                </div>
              )}
              <div className="p-4 bg-slate-50 rounded-xl">
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-xs text-slate-500">Payment Progress</span>
                  <span className="text-xs font-bold text-slate-700">{paidPct}%</span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${paidPct === 100 ? 'bg-emerald-500' : paidPct > 0 ? 'bg-amber-400' : 'bg-slate-300'}`} style={{ width: `${paidPct}%` }} />
                </div>
                <div className="flex justify-between items-center mt-2">
                  <span className="text-xs text-slate-500">{formatAmount(shipment.amountPaid, invoiceCurrency)} paid</span>
                  <PaymentBadge status={paymentStatus} />
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <FinRow label="Invoice Amount" value={baseInvoiceTotal} currency={invoiceCurrency} />
                <FinRow label="Other Charges" value={shipment.otherCharges} currency={invoiceCurrency} />
                {shipment.discount > 0 && <FinRow label="Discount" value={-shipment.discount} currency={invoiceCurrency} highlight="green" />}
                {financial.billableExtraCharges > 0 && <FinRow label="Billable Extra Charges" value={financial.billableExtraCharges} currency={invoiceCurrency} />}
                <div className="border-t border-slate-200 pt-2 flex justify-between items-center">
                  <span className="font-semibold text-slate-800">Total Due</span>
                  <span className="font-bold tabular text-base" style={{ color: 'rgb(12,28,53)' }}>{formatAmount(invoiceTotal, invoiceCurrency)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Amount Paid</span>
                  <span className="font-semibold text-emerald-600 tabular">{formatAmount(shipment.amountPaid, invoiceCurrency)}</span>
                </div>
                {balance > 0 && (
                  <div className="flex justify-between items-center bg-red-50 rounded-lg px-3 py-2 -mx-1 border border-red-100">
                    <span className="font-semibold text-red-700 text-sm">Remaining Balance</span>
                    <span className="font-bold text-red-700 tabular text-sm">{formatAmount(balance, invoiceCurrency)}</span>
                  </div>
                )}
              </div>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Cargo Extra Charges</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">Billable charges increase Total Due. Company expenses do not.</div>
                  </div>
                  {canManageExtraCharges && <button onClick={openAddCharge} className="secondary-button min-h-9 shrink-0 px-3 text-xs"><PlusCircleIcon /> Add Charge</button>}
                </div>
                {shipmentExtraCharges.length > 0 ? (
                  <div className="space-y-2">
                    {shipmentExtraCharges.map(charge => {
                      const chargeLabel = charge.chargeType === 'other' ? charge.customLabel || 'Other' : CARGO_EXTRA_CHARGE_LABELS[charge.chargeType]
                      const isBillable = charge.direction === 'billable_to_customer'
                      return (
                        <div key={charge.id} className="rounded-lg border border-slate-100 bg-white p-2.5 text-xs">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-800">{chargeLabel}</div>
                              <div className="mt-0.5 text-slate-400">{charge.chargeDate} · {isBillable ? 'Billable to customer' : 'Company expense'}</div>
                              {charge.note && <div className="mt-1 break-words text-slate-500">{charge.note}</div>}
                            </div>
                            <div className="shrink-0 text-right">
                              <div className={`font-semibold tabular ${isBillable ? 'text-navy-700' : 'text-amber-700'}`}>{formatAmount(charge.amount, charge.currency)}</div>
                              {canManageExtraCharges && <div className="mt-1 flex justify-end gap-1"><button onClick={() => openEditCharge(charge)} className="min-h-9 rounded px-2 font-semibold text-slate-500 hover:bg-slate-50">Edit</button><button onClick={() => setChargeDeleteTarget(charge)} className="min-h-9 rounded px-2 font-semibold text-red-500 hover:bg-red-50">Delete</button></div>}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
                      <MetricChip label="All Extra Charges" value={formatAmount(financial.totalExtraCharges, invoiceCurrency)} />
                      <MetricChip label="Billable Subtotal" value={formatAmount(financial.billableExtraCharges, invoiceCurrency)} />
                      <MetricChip label="Company Expense Subtotal" value={formatAmount(financial.companyExpenseCharges, invoiceCurrency)} />
                    </div>
                    {financial.existingCompanyExpenses > 0 && <div className="text-[11px] text-slate-400">Existing posted shipment expenses: {formatAmount(financial.existingCompanyExpenses, invoiceCurrency)}. These remain outside customer Total Due.</div>}
                  </div>
                ) : <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">No cargo extra charges recorded.</div>}
              </div>
              {shipmentPayments.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Payment History</div>
                  <div className="space-y-2">
                    {shipmentPayments.map(p => (
                      <div key={p.id} className="flex items-start justify-between text-xs p-2.5 bg-white border border-slate-100 rounded-lg group">
                        <div>
                          <div className="font-mono font-semibold text-navy-700">{p.receiptNumber}</div>
                          <div className="text-slate-400 mt-0.5">{p.date} · {p.method}</div>
                          {p.note && <div className="text-slate-500 mt-0.5">{p.note}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-emerald-700 tabular whitespace-nowrap">{formatAmount(p.amount, p.currency)}</span>
                          {(p.status === 'REFUNDED' || p.status === 'VOIDED') && (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${p.status === 'REFUNDED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-600'}`}>{p.status}</span>
                          )}
                          {p.status === 'POSTED' && canAccess(currentUser?.role, 'payment.refund') && (
                            <button onClick={async () => {
                              const reason = window.prompt('Reason for refunding this payment? (money must have actually been returned to the customer)')
                              if (!reason || !reason.trim()) return
                              try { await refundPayment(p.id, reason); toast.success('Payment refunded.') } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to refund payment.') }
                            }} className="min-h-11 rounded px-2 text-[11px] font-semibold text-amber-700 hover:bg-amber-50 sm:min-h-0 sm:py-1 sm:opacity-0 sm:group-hover:opacity-100">Refund</button>
                          )}
                          {p.status !== 'POSTED' && p.status !== 'REFUNDED' && p.status !== 'VOIDED' && (
                            <button onClick={async () => { if (confirm('Delete this payment record?')) { try { await deletePayment(p.id); toast.success('Payment removed') } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to remove payment.') } } }} className="flex size-11 items-center justify-center rounded text-slate-400 transition-all hover:bg-red-50 hover:text-red-500 sm:size-auto sm:p-1 sm:opacity-0 sm:group-hover:opacity-100">
                              <TrashIconSm />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {shipmentPayments.length === 0 && <div className="text-center py-4 text-xs text-slate-400">No payments recorded yet.</div>}
            </div>
          </PanelCard>
        </div>

        {/* Panel C */}
        <div>
          <PanelCard title="Status & Audit Timeline" icon={<TimelineIcon />}>
            <div className="mb-5">
              <div className="flex flex-wrap gap-1 mb-3">
                {STATUS_ORDER.map(s => {
                  const state = timelineState(shipment.status, s)
                  const isDone = state === 'complete'
                  const isCurrent = state === 'current'
                  return (
                    <div key={s} className={`flex-1 min-w-[60px] text-center text-[10px] py-1 rounded font-medium transition-colors ${isCurrent ? 'text-white' : isDone ? 'bg-navy-100 text-navy-700' : 'bg-slate-100 text-slate-400'}`}
                      style={isCurrent ? { backgroundColor: 'rgb(12,28,53)' } : undefined}>
                      {shipmentStatusLabel(s)}
                    </div>
                  )
                })}
                {shipment.isOnHold && (
                  <div className="flex-1 min-w-[60px] text-center text-[10px] py-1 rounded font-medium bg-red-100 text-red-700">On Hold</div>
                )}
              </div>
            </div>
            <div className="space-y-0">
              {[...shipment.statusHistory].reverse().map((event, i) => (
                <div key={i} className="flex gap-3 relative">
                  <div className="flex flex-col items-center">
                    <div className={`size-2.5 rounded-full mt-1.5 flex-shrink-0 ring-2 ring-white ${getStatusDot(event.status)}`} />
                    {i < shipment.statusHistory.length - 1 && <div className="w-px flex-1 bg-slate-200 my-1" />}
                  </div>
                  <div className="pb-4 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusBadge status={event.status} size="sm" />
                      {!event.isPublic && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-medium">Internal</span>}
                    </div>
                    {event.note && <div className="text-xs text-slate-700 mt-1">{event.note}</div>}
                    {event.internalNote && <div className="mt-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600"><span className="font-semibold">Internal:</span> {event.internalNote}</div>}
                    {event.isCorrection && <div className="mt-1 text-[10px] font-semibold text-amber-700">Correction: {event.correctionReason}</div>}
                    <div className="flex gap-2 mt-1 text-[10px] text-slate-400 flex-wrap">
                      <span>{event.location}</span><span>·</span><span>{event.timestamp}</span><span>·</span><span>{event.staff}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </PanelCard>
        </div>
      </div>

      {/* Record Payment Modal */}
      <Modal open={paymentModal} onClose={() => { if (!paymentSaving) { setPaymentModal(false); setPayErrors({}) } }} title="Record Payment">
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Amount ({invoiceCurrency}) <span className="text-red-500">*</span></label>
            <input value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} type="number" min="0" max={balance}
              placeholder={`Max: ${formatAmount(balance, invoiceCurrency)}`}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${payErrors.amount ? 'border-red-300' : 'border-slate-200'}`} />
            {payErrors.amount && <p className="text-xs text-red-500 mt-0.5">{payErrors.amount}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Payment Method</label>
            <select value={payForm.method} onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
              {['Bank Transfer','Cash','M-Pesa','Tigopesa','Airtel Money','Cheque','Online Transfer'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Payment Date <span className="text-red-500">*</span></label>
            <input type="date" value={payForm.date} onChange={e => setPayForm(f => ({ ...f, date: e.target.value }))} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${payErrors.date ? 'border-red-300' : 'border-slate-200'}`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Note (optional)</label>
            <input type="text" value={payForm.note} onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))} placeholder="e.g. Balance payment" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setPaymentModal(false); setPayErrors({}) }} disabled={paymentSaving} className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button onClick={handlePaymentSave} disabled={paymentSaving} className="flex-1 px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:cursor-not-allowed disabled:opacity-60" style={{ backgroundColor: 'rgb(249,115,22)' }}>{paymentSaving ? 'Recording…' : 'Record & Print Receipt'}</button>
          </div>
        </div>
      </Modal>

      <Modal open={chargeModal} onClose={() => { if (!chargeBusy) { setChargeModal(false); setEditingCharge(null); setChargeErrors({}) } }} title={editingCharge ? 'Edit Cargo Extra Charge' : 'Add Cargo Extra Charge'}>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-slate-500">Charge Type *</label><select disabled={chargeBusy} value={chargeForm.chargeType} onChange={event => { const chargeType = event.target.value as CargoExtraChargeType; setChargeForm(form => ({ ...form, chargeType, direction: DEFAULT_CHARGE_DIRECTION[chargeType] })) }} className="form-input">{CARGO_EXTRA_CHARGE_TYPES.map(type => <option key={type} value={type}>{CARGO_EXTRA_CHARGE_LABELS[type]}</option>)}</select></div>
          {chargeForm.chargeType === 'other' && <div><label className="mb-1 block text-xs font-medium text-slate-500">Custom Label *</label><input disabled={chargeBusy} value={chargeForm.customLabel} onChange={event => setChargeForm(form => ({ ...form, customLabel: event.target.value }))} className={`form-input ${chargeErrors.customLabel ? 'border-red-300' : ''}`} />{chargeErrors.customLabel && <p className="mt-1 text-xs text-red-500">{chargeErrors.customLabel}</p>}</div>}
          <div><label className="mb-1 block text-xs font-medium text-slate-500">Financial Treatment *</label><select disabled={chargeBusy || chargeForm.chargeType === 'supplier_payment'} value={chargeForm.direction} onChange={event => setChargeForm(form => ({ ...form, direction: event.target.value as ChargeDirection }))} className={`form-input ${chargeErrors.direction ? 'border-red-300' : ''}`}><option value="billable_to_customer">Billable to customer</option><option value="company_expense">Company expense</option></select>{chargeErrors.direction && <p className="mt-1 text-xs text-red-500">{chargeErrors.direction}</p>}{chargeForm.chargeType === 'supplier_payment' && <p className="mt-1 text-[11px] text-slate-400">Supplier Payment is always recorded as a company expense.</p>}</div>
          <div className="grid gap-3 sm:grid-cols-2"><div><label className="mb-1 block text-xs font-medium text-slate-500">Amount ({invoiceCurrency}) *</label><input disabled={chargeBusy} type="number" min="0.01" step="0.01" value={chargeForm.amount} onChange={event => setChargeForm(form => ({ ...form, amount: event.target.value }))} className={`form-input ${chargeErrors.amount ? 'border-red-300' : ''}`} />{chargeErrors.amount && <p className="mt-1 text-xs text-red-500">{chargeErrors.amount}</p>}</div><div><label className="mb-1 block text-xs font-medium text-slate-500">Charge Date *</label><input disabled={chargeBusy} type="date" value={chargeForm.chargeDate} onChange={event => setChargeForm(form => ({ ...form, chargeDate: event.target.value }))} className={`form-input ${chargeErrors.chargeDate ? 'border-red-300' : ''}`} />{chargeErrors.chargeDate && <p className="mt-1 text-xs text-red-500">{chargeErrors.chargeDate}</p>}</div></div>
          {chargeForm.direction === 'company_expense' && <div><label className="mb-1 block text-xs font-medium text-slate-500">Payment Method</label><select disabled={chargeBusy} value={chargeForm.paymentMethod} onChange={event => setChargeForm(form => ({ ...form, paymentMethod: event.target.value }))} className="form-input">{['Bank Transfer','Cash','M-Pesa','Tigopesa','Airtel Money','Cheque','Online Transfer'].map(method => <option key={method} value={method}>{method}</option>)}</select></div>}
          <div><label className="mb-1 block text-xs font-medium text-slate-500">Note</label><textarea disabled={chargeBusy} rows={2} value={chargeForm.note} onChange={event => setChargeForm(form => ({ ...form, note: event.target.value }))} className="form-input resize-none" /></div>
          <div className="flex gap-2 pt-1"><button disabled={chargeBusy} onClick={() => { setChargeModal(false); setEditingCharge(null); setChargeErrors({}) }} className="secondary-button min-h-11 flex-1 disabled:opacity-50">Cancel</button><button disabled={chargeBusy} onClick={handleChargeSave} className="primary-button min-h-11 flex-1 disabled:opacity-50">{chargeBusy ? 'Saving…' : editingCharge ? 'Save Changes' : 'Add Charge'}</button></div>
        </div>
      </Modal>

      <Modal open={!!itemQrCode} onClose={() => setItemQrCode(null)} title="Item QR Sticker">
        {itemQrCode && (() => {
          const item = shipment.items.find(candidate => candidate.itemCode === itemQrCode)
          return item ? <div className="flex flex-col items-center gap-4 py-2"><QRCodeSVG value={itemQrUrl(itemQrCode)} size={210} level="H" marginSize={2} /><div className="text-center"><div className="font-mono text-base font-bold text-slate-800">{itemQrCode}</div><div className="font-semibold text-slate-700 mt-1">{item.description}</div><div className="text-sm text-slate-500">{formatPackingQuantity(item.quantity)} {item.unit}</div></div><label className="flex items-center gap-2 text-xs text-slate-600">Copies <input type="number" min="1" max="100" value={stickerCopies} onChange={event => setStickerCopies(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} className="w-20 rounded-lg border border-slate-200 px-2 py-1.5" /></label><button onClick={() => handlePrintItemSticker(itemQrCode, stickerCopies)} className="primary-button w-full">Print Sticker</button></div> : null
        })()}
      </Modal>

      {/* Update Status Modal */}
      <Modal open={statusModal} onClose={() => { if (!statusSaving) { setStatusModal(false); setStatusErrors({}) } }} title="Update Shipment Status">
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="text-slate-400">Current Status</div>
            <div className="mt-1 font-bold text-slate-800">{shipmentStatusLabel(shipment.status)}</div>
            {nextStatus && <div className="mt-2 text-slate-500">Next logical stage: <span className="font-semibold text-orange-700">{shipmentStatusLabel(nextStatus)}</span></div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">New Status <span className="text-red-500">*</span></label>
            <select value={statusForm.status} onChange={e => setStatusForm(f => ({ ...f, status: e.target.value as ShipmentStatus }))}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${statusErrors.status ? 'border-red-300' : 'border-slate-200'}`}>
              <option value="">Select new status…</option>
              {availableTransitions.map(status => <option key={status} value={status}>{shipmentStatusLabel(status)}</option>)}
            </select>
            {statusErrors.status && <p className="text-xs text-red-500 mt-0.5">{statusErrors.status}</p>}
            {availableTransitions.length === 0 && <p className="text-xs text-slate-400 mt-1">No further status transitions available.</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Location <span className="text-red-500">*</span></label>
            <input value={statusForm.location} onChange={e => setStatusForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. Dubai Airport, Dar es Salaam Port"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none ${statusErrors.location ? 'border-red-300' : 'border-slate-200'}`} />
            {statusErrors.location && <p className="text-xs text-red-500 mt-0.5">{statusErrors.location}</p>}
          </div>
          {statusForm.status === 'DISPATCHED' && <div><label className="block text-xs font-medium text-slate-500 mb-1">Dispatch Reference</label><input value={statusForm.dispatchReference} onChange={event => setStatusForm(form => ({ ...form, dispatchReference: event.target.value }))} placeholder={shipment.shipmentType === 'Air Cargo' ? 'Airway Bill / Flight Reference' : 'Container / Bill of Lading Reference'} className="form-input" /></div>}
          {statusForm.status === 'IN_CUSTOMS' && <div className="grid gap-3 sm:grid-cols-2"><div><label className="block text-xs font-medium text-slate-500 mb-1">Customs Type *</label><select value={statusForm.customsType} onChange={event => setStatusForm(form => ({ ...form, customsType: event.target.value as CustomsType }))} className={`form-input ${statusErrors.customsType ? 'border-red-300' : ''}`}><option value="">Select type…</option><option value="AIRPORT">Airport</option><option value="SEA_PORT">Sea Port</option></select>{statusErrors.customsType && <p className="mt-1 text-xs text-red-500">{statusErrors.customsType}</p>}</div><div><label className="block text-xs font-medium text-slate-500 mb-1">Customs Location</label><input value={statusForm.customsLocation} onChange={event => setStatusForm(form => ({ ...form, customsLocation: event.target.value }))} placeholder="Airport or port name" className="form-input" /></div></div>}
          {statusForm.status === 'DELIVERED' && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><div className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-800">Delivery Confirmation</div><div className="grid gap-3 sm:grid-cols-2"><div><label className="block text-xs font-medium text-slate-600 mb-1">Recipient Name *</label><input value={statusForm.recipientName} onChange={event => setStatusForm(form => ({ ...form, recipientName: event.target.value }))} className={`form-input ${statusErrors.recipientName ? 'border-red-300' : ''}`} />{statusErrors.recipientName && <p className="mt-1 text-xs text-red-500">{statusErrors.recipientName}</p>}</div><div><label className="block text-xs font-medium text-slate-600 mb-1">Recipient Phone</label><input value={statusForm.recipientPhone} onChange={event => setStatusForm(form => ({ ...form, recipientPhone: event.target.value }))} className="form-input" /></div><div><label className="block text-xs font-medium text-slate-600 mb-1">Collection / Delivery Date *</label><input type="datetime-local" value={statusForm.deliveredAt} onChange={event => setStatusForm(form => ({ ...form, deliveredAt: event.target.value }))} className={`form-input ${statusErrors.deliveredAt ? 'border-red-300' : ''}`} />{statusErrors.deliveredAt && <p className="mt-1 text-xs text-red-500">{statusErrors.deliveredAt}</p>}</div><div><label className="block text-xs font-medium text-slate-600 mb-1">Released By</label><input value={currentUser?.name || ''} disabled className="form-input bg-white/70" /></div></div><label className="mt-3 block text-xs font-medium text-slate-600 mb-1">Delivery Notes</label><textarea value={statusForm.deliveryNotes} onChange={event => setStatusForm(form => ({ ...form, deliveryNotes: event.target.value }))} rows={2} className="form-input resize-none" /></div>}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Customer Tracking Note</label>
            <textarea value={statusForm.publicNote} onChange={event => setStatusForm(form => ({ ...form, publicNote: event.target.value }))} rows={2} placeholder="Safe update visible to the customer" className="form-input resize-none" />
          </div>
          <div><label className="block text-xs font-medium text-slate-500 mb-1">Internal Note</label><textarea value={statusForm.internalNote} onChange={event => setStatusForm(form => ({ ...form, internalNote: event.target.value }))} rows={2} placeholder="Staff-only note; never shown publicly" className="form-input resize-none" /></div>
          {statusForm.status && isCorrection(shipment.status, statusForm.status) && <div><label className="block text-xs font-semibold text-amber-700 mb-1">Reason for Status Correction *</label><textarea value={statusForm.correctionReason} onChange={event => setStatusForm(form => ({ ...form, correctionReason: event.target.value }))} rows={2} className={`form-input resize-none ${statusErrors.correctionReason ? 'border-red-300' : 'border-amber-300'}`} />{statusErrors.correctionReason && <p className="mt-1 text-xs text-red-500">{statusErrors.correctionReason}</p>}</div>}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setStatusModal(false); setStatusErrors({}) }} disabled={statusSaving} className="flex-1 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button onClick={handleStatusUpdate} disabled={statusSaving || availableTransitions.length === 0} className="flex-1 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40" style={{ backgroundColor: 'rgb(12,28,53)' }}>{statusSaving ? 'Updating…' : 'Update Status'}</button>
          </div>
        </div>
      </Modal>

      <Modal open={holdModal} onClose={() => setHoldModal(false)} title={shipment.isOnHold ? 'Release Shipment Hold' : 'Place Shipment On Hold'}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">On Hold is a flag and does not erase or replace the shipment lifecycle status.</p>
          {!shipment.isOnHold && <div><label className="block text-xs font-semibold text-slate-600 mb-1">Hold Reason *</label><textarea value={holdReason} onChange={event => setHoldReason(event.target.value)} rows={3} className="form-input resize-none" /></div>}
          <div className="flex gap-2"><button onClick={() => setHoldModal(false)} className="secondary-button min-h-11 flex-1">Cancel</button><button onClick={handleHoldChange} disabled={!shipment.isOnHold && !holdReason.trim()} className="primary-button min-h-11 flex-1 disabled:opacity-50">{shipment.isOnHold ? 'Release Hold' : 'Place On Hold'}</button></div>
        </div>
      </Modal>

      {/* QR Code Modal */}
      <Modal open={qrModal} onClose={() => setQrModal(false)} title="QR Code — Tracking">
        <div className="flex flex-col items-center gap-4 py-4">
          <QRCodeSVG value={`${window.location.origin}?tracking=${shipment.trackingNumber}`} size={180} level="H" />
          <div className="text-center">
            <div className="font-mono text-sm font-semibold text-slate-800">{shipment.trackingNumber}</div>
            <div className="text-xs text-slate-400 mt-1">Scan to track this shipment</div>
          </div>
        </div>
      </Modal>

      {/* Delete: VOID, REFUND and DELETE are different concepts (see
          delete_shipment()/refund_payment() in
          20260819120000_shipment_delete_and_payment_refund.sql). A shipment
          with no payments deletes directly; one with payments must choose
          whether to keep the financial record as-is or refund first. */}
      <Modal open={deleteStep === 'simple'} onClose={() => !deleteBusy && setDeleteStep('closed')} title="Delete Shipment">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">This shipment has no payments and no packing/delivery history, so it can be permanently deleted. This cannot be undone.</p>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Reason *</label>
            <textarea value={deleteReason} onChange={e => setDeleteReason(e.target.value)} rows={2} className="form-input resize-none" placeholder="Why is this shipment being deleted?" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setDeleteStep('closed')} disabled={deleteBusy} className="secondary-button min-h-11 flex-1">Cancel</button>
            <button onClick={handleDeleteNoPayments} disabled={deleteBusy || !deleteReason.trim()} className="min-h-11 flex-1 rounded-lg bg-red-500 text-sm font-semibold text-white disabled:opacity-50">{deleteBusy ? 'Deleting…' : 'Delete Permanently'}</button>
          </div>
        </div>
      </Modal>

      <Modal open={deleteStep === 'choice'} onClose={() => !deleteBusy && setDeleteStep('closed')} title="Delete Shipment">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">This shipment has {postedPayments.length} posted payment{postedPayments.length === 1 ? '' : 's'} on file ({formatAmount(postedPayments.reduce((sum, p) => sum + p.amount, 0), postedPayments[0]?.currency ?? invoiceCurrency)}). Deleting it will not destroy that money trail — choose how to handle it:</p>
          <div className="space-y-2">
            <button onClick={() => setDeleteStep('keep')} className="w-full rounded-lg border border-slate-200 p-3 text-left text-sm hover:bg-slate-50">
              <div className="font-semibold text-slate-800">Delete Shipment & Keep Financial Record</div>
              <div className="text-xs text-slate-500 mt-0.5">The shipment record is removed; its payments stay exactly as posted, findable in Financial Reports.</div>
            </button>
            <button onClick={() => setDeleteStep('refund')} className="w-full rounded-lg border border-slate-200 p-3 text-left text-sm hover:bg-slate-50">
              <div className="font-semibold text-slate-800">Refund Payment{postedPayments.length === 1 ? '' : 's'} & Delete Shipment</div>
              <div className="text-xs text-slate-500 mt-0.5">Reverses the ledger for each posted payment, marks it REFUNDED with a linked refund record, then deletes the shipment.</div>
            </button>
          </div>
          <button onClick={() => setDeleteStep('closed')} className="secondary-button min-h-11 w-full">Cancel</button>
        </div>
      </Modal>

      <Modal open={deleteStep === 'keep'} onClose={() => !deleteBusy && setDeleteStep('closed')} title="Delete Shipment & Keep Financial Record">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">The {postedPayments.length} posted payment{postedPayments.length === 1 ? '' : 's'} on this shipment will remain POSTED and stay visible in Financial Reports (shown by tracking number, since the shipment itself will be gone). Nothing is refunded.</p>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Reason *</label>
            <textarea value={deleteReason} onChange={e => setDeleteReason(e.target.value)} rows={2} className="form-input resize-none" placeholder="Why is this shipment being deleted?" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setDeleteStep('choice')} disabled={deleteBusy} className="secondary-button min-h-11 flex-1">Back</button>
            <button onClick={handleDeleteKeepFinancial} disabled={deleteBusy || !deleteReason.trim()} className="min-h-11 flex-1 rounded-lg bg-red-500 text-sm font-semibold text-white disabled:opacity-50">{deleteBusy ? 'Deleting…' : 'Delete & Keep Record'}</button>
          </div>
        </div>
      </Modal>

      <Modal open={deleteStep === 'refund'} onClose={() => !deleteBusy && setDeleteStep('closed')} title="Refund Payments & Delete Shipment">
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1.5">
            <div className="flex justify-between"><span className="text-slate-500">Shipment</span><span className="font-mono font-semibold text-slate-800">{shipment.trackingNumber}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Customer</span><span className="font-semibold text-slate-800">{customer?.company || customer?.name || '—'}</span></div>
          </div>
          <div className="space-y-2">
            {postedPayments.map(p => (
              <div key={p.id} className="rounded-lg border border-slate-200 p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="font-mono font-semibold text-navy-700">{p.receiptNumber}</span><span className="font-semibold text-emerald-700">{formatAmount(p.amount, p.currency)}</span></div>
                <div className="flex justify-between text-slate-500"><span>{p.method} · {p.date}</span><span>Refund amount: {formatAmount(p.amount, p.currency)}</span></div>
                <div className="flex justify-between text-slate-500"><span>Status</span><span className="font-semibold text-amber-700">POSTED → REFUNDED</span></div>
              </div>
            ))}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Reason *</label>
            <textarea value={deleteReason} onChange={e => setDeleteReason(e.target.value)} rows={2} className="form-input resize-none" placeholder="Why are these payments being refunded?" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setDeleteStep('choice')} disabled={deleteBusy} className="secondary-button min-h-11 flex-1">Back</button>
            <button onClick={handleRefundAndDelete} disabled={deleteBusy || !deleteReason.trim()} className="min-h-11 flex-1 rounded-lg bg-red-500 text-sm font-semibold text-white disabled:opacity-50">{deleteBusy ? 'Processing…' : `Refund ${postedPayments.length > 1 ? 'All' : ''} & Delete`}</button>
          </div>
        </div>
      </Modal>

      <Modal open={voidModal} onClose={() => !voidBusy && setVoidModal(false)} title="Void Shipment">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">This shipment has payments, an invoice or a journal entry on file, so it can't be deleted. Voiding keeps every record intact (payments, invoice, accounting) and marks it canceled — an Admin can restore it anytime.</p>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Reason *</label>
            <textarea value={voidReason} onChange={event => setVoidReason(event.target.value)} rows={3} className="form-input resize-none" placeholder="Why is this shipment being voided?" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setVoidModal(false)} disabled={voidBusy} className="secondary-button min-h-11 flex-1">Cancel</button>
            <button onClick={handleVoid} disabled={voidBusy || !voidReason.trim()} className="primary-button min-h-11 flex-1 disabled:opacity-50">{voidBusy ? 'Voiding…' : 'Void Shipment'}</button>
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={Boolean(chargeDeleteTarget)}
        title="Delete Cargo Extra Charge"
        message={chargeDeleteTarget ? `Delete ${chargeDeleteTarget.chargeType === 'other' ? chargeDeleteTarget.customLabel || 'this charge' : CARGO_EXTRA_CHARGE_LABELS[chargeDeleteTarget.chargeType]} (${formatAmount(chargeDeleteTarget.amount, chargeDeleteTarget.currency)})? Its accounting entry will be reversed and the audit trail retained.` : ''}
        confirmLabel="Delete Charge"
        busy={chargeBusy}
        onConfirm={handleChargeDelete}
        onCancel={() => { if (!chargeBusy) setChargeDeleteTarget(null) }}
      />
    </div>
  )
}

function getStatusDot(status: ShipmentStatus) {
  const map: Record<ShipmentStatus, string> = { RECEIVED: 'bg-blue-500', PACKED: 'bg-amber-400', DISPATCHED: 'bg-orange-500', ON_TRANSIT: 'bg-sky-500', IN_CUSTOMS: 'bg-violet-500', ARRIVED: 'bg-emerald-500', DELIVERED: 'bg-green-600' }
  return map[status] || 'bg-slate-400'
}

function PanelCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3.5 border-b border-slate-100 bg-slate-50">
        <span className="text-slate-500">{icon}</span>
        <span className="text-sm font-semibold text-slate-700">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-400 text-xs min-w-[88px] flex-shrink-0">{label}</span>
      <span className="text-slate-700 text-xs">{value}</span>
    </div>
  )
}

function PackingSummaryBadge({ state }: { state: 'NOT_PACKED' | 'PARTIALLY_PACKED' | 'FULLY_PACKED' }) {
  const classes = state === 'FULLY_PACKED' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : state === 'PARTIALLY_PACKED' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-100 text-slate-500 border-slate-200'
  const label = state === 'FULLY_PACKED' ? 'Fully Packed' : state === 'PARTIALLY_PACKED' ? 'Partially Packed' : 'Not Packed'
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${classes}`}>{label}</span>
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-50 rounded-lg p-2 text-center border border-slate-100">
      <div className="font-mono text-xs font-bold text-navy-800 tabular">{value}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">{label}</div>
    </div>
  )
}

function FinRow({ label, value, currency, highlight }: { label: string; value: number; currency: import('../types').Currency; highlight?: string }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular ${highlight === 'green' ? 'text-emerald-600 font-medium' : 'text-slate-700'}`}>
        {formatAmount(Math.abs(value), currency)}
      </span>
    </div>
  )
}

const ArrowLeftIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
const BoxIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
const CurrencyIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
const TimelineIcon = () => <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
const PlusCircleIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
const PrintIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
const EditIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
const QrIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" /></svg>
const ExternalIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
const TrashIcon = () => <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
const TrashIconSm = () => <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
const PlaneIconSm = () => <svg className="size-3" style={{ color: 'rgb(249,115,22)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
