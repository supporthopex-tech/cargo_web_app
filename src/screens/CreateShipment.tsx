import { useState } from 'react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import { findApplicableExchangeRate } from '../lib/exchangeRateService'
import { calculateBaseAmount, calculateCbm, invoiceAmountFor } from '../lib/pricing'
import { nextTrackingNumber } from '../lib/autoNumber'
import { useAppStore } from '../store/useAppStore'
import { canAccess, useAuthStore } from '../store/useAuthStore'
import { useRatesStore } from '../store/useRatesStore'
import PageHeader from '../components/PageHeader'
import {
  TANZANIA_CITIES,
  formatAmount,
  type Currency,
  type Shipment,
  type ShipmentItem,
  type ShipmentItemUnit,
  type ShipmentType,
} from '../types'

const STEPS = ['Customer', 'Shipping Method', 'Cargo Items', 'Weight / CBM', 'Shipping Price', 'Currency', 'Review', 'Create']
const ITEM_UNITS: ShipmentItemUnit[] = ['PCS', 'BOX', 'CARTON', 'BAG', 'SET', 'PALLET', 'UNIT', 'OTHER']

interface Props { onNavigate: (screen: Screen, id?: string) => void }

function emptyItem(number: number): ShipmentItem {
  return { itemNumber: number, description: '', quantity: 1, unit: 'PCS', sortOrder: number - 1 }
}

export default function CreateShipment({ onNavigate }: Props) {
  const { customers, shipments, settings, addCustomer, addShipment } = useAppStore()
  const { getShippingRate, exchangeRates } = useRatesStore()
  const currentUser = useAuthStore(state => state.currentUser)
  const today = new Date().toISOString().slice(0, 10)

  const [step, setStep] = useState(0)
  const [customerId, setCustomerId] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', email: '' })
  const [shippingMethod, setShippingMethod] = useState<ShipmentType>('Air Cargo')
  const [destinationCity, setDestinationCity] = useState('Dar es Salaam')
  const [items, setItems] = useState<ShipmentItem[]>([emptyItem(1)])
  const [weightKg, setWeightKg] = useState('')
  const [totalCbm, setTotalCbm] = useState('')
  const [dimensions, setDimensions] = useState({ length: '', width: '', height: '', packages: '1' })
  const [showCbmCalculator, setShowCbmCalculator] = useState(false)
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideRate, setOverrideRate] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [invoiceCurrency, setInvoiceCurrency] = useState<Currency>('USD')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [createdShipment, setCreatedShipment] = useState<Shipment | null>(null)

  const selectedCustomer = customers.find(customer => customer.id === customerId)
  const matchingCustomers = customers.filter(customer => {
    if (customer.archivedAt) return false
    const query = customerSearch.trim().toLowerCase()
    return query && [customer.name, customer.company, customer.phone, customer.email]
      .some(value => value.toLowerCase().includes(query))
  }).slice(0, 6)
  const configuredRate = getShippingRate(shippingMethod, today)
  const canOverride = canAccess(currentUser?.role, 'shipment.rate_override')
  const pricingUnit = shippingMethod === 'Air Cargo' ? 'KG' : 'CBM'
  const measurement = shippingMethod === 'Air Cargo' ? weightKg : totalCbm
  const appliedRate = overrideEnabled ? overrideRate : configuredRate ? String(configuredRate.rate) : ''
  const baseAmountUsd = measurement && appliedRate ? calculateBaseAmount(measurement, appliedRate) : '0.00'
  const applicableFx = findApplicableExchangeRate(exchangeRates, today, settings.exchangeRatePolicy)
  const usdToTzs = applicableFx?.rate.usdToTzs
  const usdToAed = applicableFx?.rate.usdToAed
  const tzsAmount = usdToTzs ? invoiceAmountFor(baseAmountUsd, 'TZS', String(usdToTzs)) : undefined
  const aedAmount = usdToAed ? invoiceAmountFor(baseAmountUsd, 'AED', undefined, String(usdToAed)) : undefined
  const invoiceAmount = (() => {
    try {
      return invoiceAmountFor(baseAmountUsd, invoiceCurrency, usdToTzs && String(usdToTzs), usdToAed && String(usdToAed))
    } catch {
      return undefined
    }
  })()
  const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  const previewTracking = nextTrackingNumber(shipments.map(shipment => shipment.trackingNumber))

  function validateStep(index: number): string | null {
    if (index === 0 && !selectedCustomer && !newCustomer.name.trim()) return 'Customer Name is required.'
    if (index === 1 && !destinationCity) return 'Destination City is required.'
    if (index === 2) {
      if (items.length === 0) return 'Add at least one cargo item.'
      if (items.some(item => !item.description.trim() || Number(item.quantity) <= 0)) return 'Every cargo item needs a description and quantity greater than zero.'
    }
    if (index === 3 && (!measurement || Number(measurement) <= 0)) {
      return shippingMethod === 'Air Cargo' ? 'Total Weight must be greater than zero.' : 'Total CBM must be greater than zero.'
    }
    if (index === 4) {
      if (!configuredRate) return `${shippingMethod} rate has not been configured. Please contact an administrator.`
      if (overrideEnabled && (!canOverride || Number(overrideRate) <= 0 || !overrideReason.trim())) return 'An authorized override requires a positive rate and a reason.'
    }
    if (index === 5 && invoiceCurrency !== 'USD' && !invoiceAmount) {
      return `An exchange rate for ${invoiceCurrency} is not available. Please update Exchange Rates before generating this invoice.`
    }
    return null
  }

  function next() {
    const error = validateStep(step)
    if (error) { toast.error(error); return }
    setStep(current => Math.min(current + 1, STEPS.length - 1))
  }

  function updateItem(index: number, patch: Partial<ShipmentItem>) {
    setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  }

  function addItem() {
    setItems(current => [...current, emptyItem(current.length + 1)])
  }

  function deleteItem(index: number) {
    setItems(current => current.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({
      ...item, itemNumber: itemIndex + 1, sortOrder: itemIndex,
    })))
  }

  function useCalculatedCbm() {
    const cbm = calculateCbm(dimensions.length, dimensions.width, dimensions.height, dimensions.packages)
    if (Number(cbm) <= 0) { toast.error('Enter positive dimensions and package count.'); return }
    setTotalCbm(cbm)
  }

  async function resolveCustomerId(): Promise<string> {
    if (selectedCustomer) return selectedCustomer.id
    const normalizedName = newCustomer.name.trim().toLowerCase()
    const duplicate = customers.find(customer =>
      customer.name.trim().toLowerCase() === normalizedName ||
      (newCustomer.phone.trim() && customer.phone.trim() === newCustomer.phone.trim()) ||
      (newCustomer.email.trim() && customer.email.trim().toLowerCase() === newCustomer.email.trim().toLowerCase())
    )
    if (duplicate) return duplicate.id
    const customer = await addCustomer({
      name: newCustomer.name.trim(),
      company: newCustomer.name.trim(),
      phone: newCustomer.phone.trim(),
      email: newCustomer.email.trim(),
      address: '',
      city: destinationCity,
      notes: 'Created during shipment entry.',
    })
    return customer.id
  }

  async function createShipment() {
    for (let index = 0; index <= 5; index += 1) {
      const error = validateStep(index)
      if (error) { toast.error(error); setStep(index); return }
    }
    if (!configuredRate || !invoiceAmount || !currentUser) return
    setSaving(true)
    try {
      const resolvedCustomerId = await resolveCustomerId()
      const customer = useAppStore.getState().customers.find(entry => entry.id === resolvedCustomerId)
      const selectedRate = invoiceCurrency === 'TZS' ? usdToTzs : invoiceCurrency === 'AED' ? usdToAed : 1
      const shipment = await addShipment({
        status: 'RECEIVED',
        shipmentType: shippingMethod,
        cargoCategory: 'General Cargo',
        serviceType: shippingMethod,
        customerId: resolvedCustomerId,
        origin: settings.defaultOrigin,
        destination: settings.defaultDestinationCountry,
        destinationCity,
        description: items.map(item => item.description.trim()).join(', '),
        items,
        weightKg: shippingMethod === 'Air Cargo' ? Number(weightKg) : 0,
        volumeCbm: shippingMethod === 'Sea Cargo' ? Number(totalCbm) : 0,
        pcs: Math.round(totalQuantity),
        shippingRate: `USD ${appliedRate} / ${pricingUnit}`,
        baseRate: Number(invoiceAmount),
        otherCharges: 0,
        discount: 0,
        totalAmount: Number(invoiceAmount),
        amountPaid: 0,
        currency: invoiceCurrency,
        customerNameSnapshot: customer?.name || newCustomer.name.trim(),
        customerPhoneSnapshot: customer?.phone || newCustomer.phone.trim(),
        customerEmailSnapshot: customer?.email || newCustomer.email.trim(),
        pricingUnit,
        standardRateUsd: configuredRate.rate,
        appliedRateUsd: Number(appliedRate),
        rateOverridden: overrideEnabled,
        overrideReason: overrideEnabled ? overrideReason.trim() : undefined,
        overriddenBy: overrideEnabled ? currentUser.id : undefined,
        overrideTimestamp: overrideEnabled ? new Date().toISOString() : undefined,
        baseCurrency: 'USD',
        baseAmountUsd: Number(baseAmountUsd),
        usdToTzsRateUsed: usdToTzs,
        usdToAedRateUsed: usdToAed,
        selectedExchangeRate: selectedRate,
        exchangeRateDate: applicableFx?.rate.rateDate,
        invoiceCurrency,
        invoiceAmount: Number(invoiceAmount),
        invoiceNumber: `INV-${previewTracking}`,
        invoiceFinalizedAt: new Date().toISOString(),
        notes,
        createdBy: currentUser.email,
      })
      setCreatedShipment(shipment)
      setStep(7)
      toast.success(`Shipment ${shipment.trackingNumber} created successfully.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create shipment.')
    } finally {
      setSaving(false)
    }
  }

  function resetForAnotherShipment() {
    setCreatedShipment(null)
    setStep(0)
    setCustomerId('')
    setCustomerSearch('')
    setNewCustomer({ name: '', phone: '', email: '' })
    setItems([emptyItem(1)])
    setWeightKg('')
    setTotalCbm('')
    setOverrideEnabled(false)
    setOverrideRate('')
    setOverrideReason('')
    setInvoiceCurrency('USD')
    setNotes('')
  }

  if (createdShipment) {
    return (
      <PageShell title="Shipment Created Successfully" subtitle={createdShipment.trackingNumber}>
        <div className="mx-auto max-w-2xl rounded-2xl border border-emerald-200 bg-white p-4 sm:p-6">
          <div className="size-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-2xl mb-4">✓</div>
          <SummaryRow label="Customer" value={createdShipment.customerNameSnapshot || '—'} />
          <SummaryRow label="Shipping" value={createdShipment.shipmentType} />
          <SummaryRow label="Cargo" value={`${createdShipment.items.length} item types / ${totalQuantity} units`} />
          <SummaryRow label={createdShipment.pricingUnit === 'KG' ? 'Weight' : 'Volume'} value={`${measurement} ${createdShipment.pricingUnit}`} />
          <SummaryRow label="Shipping Rate" value={`USD ${createdShipment.appliedRateUsd} / ${createdShipment.pricingUnit}`} />
          <SummaryRow label="Invoice" value={formatAmount(createdShipment.invoiceAmount || 0, createdShipment.invoiceCurrency || 'USD')} />
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button onClick={() => onNavigate('shipment-detail', createdShipment.id)} className="primary-button min-h-11">View Shipment / Invoice</button>
            <button onClick={resetForAnotherShipment} className="secondary-button min-h-11">Create Another Shipment</button>
          </div>
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell title="Create Shipment" subtitle={`Tracking preview: ${previewTracking}`}>
      <div className="max-w-5xl mx-auto">
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-8">
          {STEPS.map((label, index) => (
            <button key={label} onClick={() => index < step && setStep(index)} className={`rounded-lg px-2 py-2 text-[11px] text-center border ${index === step ? 'bg-[#0c1c35] text-white border-[#0c1c35]' : index < step ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-white text-slate-400 border-slate-200'}`}>
              <span className="font-bold block">{index + 1}</span>{label}
            </button>
          ))}
        </div>

        <div className="min-h-[390px] rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 md:p-7">
          {step === 0 && (
            <Step title="Customer" hint="Search an existing customer or enter a new customer name.">
              <label className="form-label">Search customers</label>
              <input value={customerSearch} onChange={event => { setCustomerSearch(event.target.value); setCustomerId('') }} className="form-input" placeholder="Name, phone or email" />
              {matchingCustomers.length > 0 && (
                <div className="border border-slate-200 rounded-xl overflow-hidden mt-2">
                  {matchingCustomers.map(customer => (
                    <button key={customer.id} onClick={() => { setCustomerId(customer.id); setCustomerSearch(customer.name) }} className="block w-full text-left px-4 py-3 hover:bg-slate-50 border-b last:border-0">
                      <span className="block font-semibold text-sm text-slate-800">{customer.name}</span>
                      <span className="text-xs text-slate-500">{customer.phone || 'No phone'} · {customer.email || 'No email'}</span>
                    </button>
                  ))}
                </div>
              )}
              {!selectedCustomer && (
                <div className="grid md:grid-cols-3 gap-3 mt-5 pt-5 border-t">
                  <Field label="Customer Name *"><input value={newCustomer.name} onChange={event => setNewCustomer(current => ({ ...current, name: event.target.value }))} className="form-input" /></Field>
                  <Field label="Phone Number"><input type="tel" value={newCustomer.phone} onChange={event => setNewCustomer(current => ({ ...current, phone: event.target.value }))} className="form-input" /></Field>
                  <Field label="Email Address"><input type="email" value={newCustomer.email} onChange={event => setNewCustomer(current => ({ ...current, email: event.target.value }))} className="form-input" /></Field>
                </div>
              )}
              {selectedCustomer && <div className="mt-4 rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm"><strong>{selectedCustomer.name}</strong><div className="text-blue-700">{selectedCustomer.phone} · {selectedCustomer.email}</div></div>}
            </Step>
          )}

          {step === 1 && (
            <Step title="Shipping Method" hint="Choose how this cargo will be charged.">
              <div className="grid md:grid-cols-2 gap-4">
                {(['Air Cargo', 'Sea Cargo'] as ShipmentType[]).map(method => (
                  <button key={method} onClick={() => { setShippingMethod(method); setOverrideEnabled(false) }} className={`text-left rounded-2xl border-2 p-6 ${shippingMethod === method ? 'border-orange-500 bg-orange-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <span className="text-3xl">{method === 'Air Cargo' ? '✈' : '▰'}</span>
                    <strong className="block text-lg mt-3">{method.toUpperCase()}</strong>
                    <span className="text-sm text-slate-500">Charged by {method === 'Air Cargo' ? 'KG' : 'CBM'}</span>
                  </button>
                ))}
              </div>
              <Field label="Destination City *"><select value={destinationCity} onChange={event => setDestinationCity(event.target.value)} className="form-input mt-5">{TANZANIA_CITIES.map(city => <option key={city}>{city}</option>)}</select></Field>
            </Step>
          )}

          {step === 2 && (
            <Step title="Cargo Items" hint="Quantity is cargo count, not shipment weight.">
              <div className="space-y-3">
                {items.map((item, index) => (
                  <div key={item.itemNumber} className="grid grid-cols-2 items-end gap-3 rounded-xl border border-slate-200 p-3 md:grid-cols-12">
                    <span className="col-span-2 text-xs font-bold text-slate-400 md:col-span-1">ITEM {index + 1}</span>
                    <Field className="col-span-2 md:col-span-6" label="Description *"><input value={item.description} onChange={event => updateItem(index, { description: event.target.value })} className="form-input" /></Field>
                    <Field className="col-span-1 md:col-span-2" label="Quantity *"><input inputMode="decimal" type="number" min="0.001" step="0.001" value={item.quantity} onChange={event => updateItem(index, { quantity: Number(event.target.value) })} className="form-input" /></Field>
                    <Field className="col-span-1 md:col-span-2" label="Unit"><select value={item.unit} onChange={event => updateItem(index, { unit: event.target.value as ShipmentItemUnit })} className="form-input">{ITEM_UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></Field>
                    <button disabled={items.length === 1} onClick={() => deleteItem(index)} className="col-span-2 min-h-11 rounded-lg border border-red-100 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:text-slate-300 md:col-span-1" aria-label={`Remove item ${index + 1}`}>Remove</button>
                  </div>
                ))}
              </div>
              <button onClick={addItem} className="secondary-button mt-4">+ Add Another Item</button>
              <div className="mt-5 bg-slate-50 rounded-xl p-4 text-sm"><strong>Item Types:</strong> {items.length}<span className="mx-3 text-slate-300">|</span><strong>Total Quantity:</strong> {totalQuantity}</div>
            </Step>
          )}

          {step === 3 && (
            <Step title={shippingMethod === 'Air Cargo' ? 'Total Weight' : 'Total CBM'} hint={`Pricing unit: ${pricingUnit}`}>
              {shippingMethod === 'Air Cargo' ? (
                <Field label="Total Weight (KG) *"><input type="number" min="0.0001" step="0.0001" value={weightKg} onChange={event => setWeightKg(event.target.value)} className="form-input text-lg" placeholder="20.75" /></Field>
              ) : (
                <>
                  <Field label="Total CBM *"><input type="number" min="0.0001" step="0.0001" value={totalCbm} onChange={event => setTotalCbm(event.target.value)} className="form-input text-lg" placeholder="3.5" /></Field>
                  <button onClick={() => setShowCbmCalculator(value => !value)} className="text-sm text-orange-600 font-semibold mt-3">Calculate CBM from dimensions</button>
                  {showCbmCalculator && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 p-4 rounded-xl bg-slate-50">
                      {(['length','width','height','packages'] as const).map(key => <Field key={key} label={key === 'packages' ? 'Packages' : `${key[0].toUpperCase()}${key.slice(1)} (CM)`}><input type="number" min="0" value={dimensions[key]} onChange={event => setDimensions(current => ({ ...current, [key]: event.target.value }))} className="form-input" /></Field>)}
                      <button onClick={useCalculatedCbm} className="primary-button self-end">Use CBM</button>
                    </div>
                  )}
                </>
              )}
            </Step>
          )}

          {step === 4 && (
            <Step title="Shipping Price" hint="Company rates are maintained in USD only.">
              {!configuredRate ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800">
                  <strong>{shippingMethod} rate has not been configured.</strong>
                  <p className="text-sm mt-1">Please contact an administrator.</p>
                  {canAccess(currentUser?.role, 'shipping_rates.manage') && <button onClick={() => onNavigate('settings')} className="secondary-button mt-3">Update Shipping Rates</button>}
                </div>
              ) : (
                <>
                  <div className="grid md:grid-cols-3 gap-4">
                    <Metric label={shippingMethod === 'Air Cargo' ? 'Weight' : 'Volume'} value={`${measurement || '0'} ${pricingUnit}`} />
                    <Metric label={`Company Rate / ${pricingUnit}`} value={`USD ${configuredRate.rate}`} />
                    <Metric label="Base Shipping Price" value={`USD ${baseAmountUsd}`} highlight />
                  </div>
                  <div className="mt-5 text-center text-lg font-semibold">{measurement || '0'} × USD {appliedRate || '0'} / {pricingUnit} = USD {baseAmountUsd}</div>
                  {canOverride && (
                    <div className="mt-6 pt-5 border-t">
                      <label className="flex gap-2 items-center text-sm font-semibold"><input type="checkbox" checked={overrideEnabled} onChange={event => setOverrideEnabled(event.target.checked)} /> Override Rate</label>
                      {overrideEnabled && <div className="grid md:grid-cols-2 gap-3 mt-3"><Field label={`New Rate (USD / ${pricingUnit}) *`}><input type="number" value={overrideRate} onChange={event => setOverrideRate(event.target.value)} className="form-input" /></Field><Field label="Override Reason *"><input value={overrideReason} onChange={event => setOverrideReason(event.target.value)} className="form-input" /></Field></div>}
                    </div>
                  )}
                </>
              )}
            </Step>
          )}

          {step === 5 && (
            <Step title="Invoice Currency" hint="Which currency will the customer pay in?">
              {applicableFx?.isCarryForward && <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">Using approved exchange rate from {applicableFx.rate.rateDate}. This date will be saved on the invoice.</div>}
              {!applicableFx && <div className="mb-4 rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-800">Today's exchange rates have not been configured. USD invoices may continue; TZS/AED invoices are blocked.</div>}
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {(['USD','TZS','AED'] as Currency[]).map(currency => <button key={currency} onClick={() => setInvoiceCurrency(currency)} className={`min-h-11 rounded-xl border-2 p-3 font-bold sm:p-5 ${invoiceCurrency === currency ? 'border-orange-500 bg-orange-50 text-orange-800' : 'border-slate-200'}`}>{currency}</button>)}
              </div>
              <div className="grid md:grid-cols-3 gap-4 mt-6">
                <Metric label="USD" value={formatAmount(Number(baseAmountUsd), 'USD')} />
                <Metric label="TZS" value={tzsAmount ? formatAmount(Number(tzsAmount), 'TZS') : 'Not available'} />
                <Metric label="AED" value={aedAmount ? formatAmount(Number(aedAmount), 'AED') : 'Not available'} />
              </div>
              <div className="mt-5 flex flex-col gap-2 rounded-xl bg-[#0c1c35] p-5 text-white sm:flex-row sm:justify-between"><span>Total Due</span><strong className="break-words text-xl">{invoiceAmount ? formatAmount(Number(invoiceAmount), invoiceCurrency) : 'Rate required'}</strong></div>
            </Step>
          )}

          {step === 6 && (
            <Step title="Review Shipment" hint="Confirm the customer, cargo, price and invoice before creating.">
              <div className="grid md:grid-cols-2 gap-4">
                <ReviewCard title="Customer"><SummaryRow label="Name" value={selectedCustomer?.name || newCustomer.name} /><SummaryRow label="Phone" value={selectedCustomer?.phone || newCustomer.phone || '—'} /><SummaryRow label="Email" value={selectedCustomer?.email || newCustomer.email || '—'} /></ReviewCard>
                <ReviewCard title="Shipping"><SummaryRow label="Method" value={shippingMethod} /><SummaryRow label="Destination" value={`${destinationCity}, Tanzania`} /><SummaryRow label={pricingUnit} value={`${measurement} ${pricingUnit}`} /></ReviewCard>
                <ReviewCard title="Cargo Items">{items.map(item => <SummaryRow key={item.itemNumber} label={`${item.itemNumber}. ${item.description}`} value={`${item.quantity} ${item.unit}`} />)}</ReviewCard>
                <ReviewCard title="Pricing & Invoice"><SummaryRow label="Applied Rate" value={`USD ${appliedRate} / ${pricingUnit}`} /><SummaryRow label="Base Value" value={`USD ${baseAmountUsd}`} /><SummaryRow label="Invoice Currency" value={invoiceCurrency} /><SummaryRow label="Invoice Total" value={invoiceAmount ? formatAmount(Number(invoiceAmount), invoiceCurrency) : '—'} /><SummaryRow label="FX Rate Date" value={applicableFx?.rate.rateDate || 'Not required for USD'} /></ReviewCard>
              </div>
              <Field label="Internal Notes"><textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} className="form-input resize-none" /></Field>
            </Step>
          )}

          {step === 7 && !createdShipment && (
            <Step title="Create Shipment / Invoice" hint="The exact cargo and exchange rates below will be saved permanently.">
              <div className="max-w-xl mx-auto text-center py-8">
                <div className="text-4xl mb-4">✓</div>
                <h3 className="text-xl font-bold text-slate-800">Ready to create {previewTracking}</h3>
                <p className="text-sm text-slate-500 mt-2">Invoice: {invoiceAmount ? formatAmount(Number(invoiceAmount), invoiceCurrency) : '—'}</p>
                <button onClick={createShipment} disabled={saving} className="primary-button mt-6 px-8 py-3">{saving ? 'Creating…' : 'Create Shipment & Invoice'}</button>
              </div>
            </Step>
          )}
        </div>

        <div className="sticky bottom-0 z-10 -mx-3 mt-4 flex items-center border-t border-slate-200 bg-white/95 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
          <button onClick={() => step === 0 ? onNavigate('dashboard') : setStep(current => current - 1)} className="secondary-button min-h-11">{step === 0 ? 'Cancel' : 'Back'}</button>
          {step < 7 && <button onClick={next} className="primary-button ml-auto min-h-11">Continue</button>}
        </div>
      </div>
    </PageShell>
  )
}

function PageShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <div className="app-page"><PageHeader title={title} description={<span className="break-all">{subtitle}</span>} />{children}</div>
}

function Step({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return <section><h2 className="text-lg font-bold text-slate-800">{title}</h2><p className="text-sm text-slate-500 mb-6">{hint}</p><div className="space-y-4">{children}</div></section>
}

function Field({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`block ${className}`}><span className="form-label">{label}</span>{children}</label>
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return <div className={`rounded-xl border p-4 ${highlight ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-slate-50'}`}><div className="text-xs text-slate-500">{label}</div><div className="font-bold text-slate-800 mt-1">{value}</div></div>
}

function ReviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-slate-200 p-4"><h3 className="text-xs font-bold uppercase tracking-wide text-orange-600 mb-3">{title}</h3>{children}</div>
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4 py-1.5 text-sm border-b border-slate-100 last:border-0"><span className="text-slate-500">{label}</span><span className="font-medium text-slate-800 text-right">{value}</span></div>
}
