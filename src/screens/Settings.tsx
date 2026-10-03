import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import type { Screen } from '../App'
import { useAppStore } from '../store/useAppStore'
import { canAccess, useAuthStore } from '../store/useAuthStore'
import { useRatesStore } from '../store/useRatesStore'
import type { ExchangeRateSource, ItemStickerSize, ShipmentType } from '../types'
import PageHeader from '../components/PageHeader'

type SettingsTab = 'company' | 'shipping' | 'exchange' | 'printing'

interface Props { onNavigate: (screen: Screen) => void }

export default function Settings({ onNavigate }: Props) {
  const { settings, updateSettings } = useAppStore()
  const { shippingRates, exchangeRates, saveShippingRate, saveExchangeRate } = useRatesStore()
  const { currentUser, users, loadUsers } = useAuthStore()
  const [tab, setTab] = useState<SettingsTab>('company')
  const [form, setForm] = useState({ ...settings })
  const today = new Date().toISOString().slice(0, 10)
  const [shippingForm, setShippingForm] = useState({ air: '', sea: '', effectiveFrom: today })
  const [fxForm, setFxForm] = useState({ rateDate: today, usdToTzs: '', usdToAed: '', source: 'MANUAL' as ExchangeRateSource, notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadUsers() }, [loadUsers])

  if (!canAccess(currentUser?.role, 'settings')) {
    return <div className="min-h-full flex items-center justify-center bg-slate-50 p-12"><div className="text-center"><div className="text-4xl mb-3">🔒</div><h2 className="font-semibold text-slate-800">Access Restricted</h2><p className="text-sm text-slate-500">Only Admin or Manager can change company settings and rates.</p></div></div>
  }

  const activeRate = (method: ShipmentType) => shippingRates.find(rate => rate.shippingMethod === method && rate.isActive)
  const displayUser = (id?: string) => users.find(user => user.id === id)?.name || (id === currentUser?.id ? currentUser?.name : id?.slice(0, 8)) || '—'

  async function saveCompany() {
    setSaving(true)
    try { await updateSettings(form); toast.success('Company settings saved.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Settings could not be saved.') }
    finally { setSaving(false) }
  }

  async function saveCargoRate(method: ShipmentType) {
    const value = method === 'Air Cargo' ? shippingForm.air : shippingForm.sea
    if (Number(value) <= 0) { toast.error('Enter a positive USD rate.'); return }
    setSaving(true)
    try { await saveShippingRate(method, value, shippingForm.effectiveFrom); toast.success(`${method} rate saved with history.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Shipping rate could not be saved.') }
    finally { setSaving(false) }
  }

  async function saveFx() {
    if (!currentUser || Number(fxForm.usdToTzs) <= 0 || Number(fxForm.usdToAed) <= 0) { toast.error('Enter positive USD/TZS and USD/AED rates.'); return }
    setSaving(true)
    try { await saveExchangeRate({ ...fxForm, userId: currentUser.id }); toast.success(`Exchange rates for ${fxForm.rateDate} saved.`) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Exchange rates could not be saved.') }
    finally { setSaving(false) }
  }

  return (
    <div className="app-page">
      <div className="max-w-5xl mx-auto">
        <PageHeader title="Settings" description="Company, rates and cargo printing defaults" action={<button onClick={() => onNavigate('dashboard')} className="secondary-button">Back to Dashboard</button>} />
        <div className="flex gap-2 mb-5 overflow-x-auto">
          {([['company','Company'],['shipping','Shipping Rates'],['exchange','Exchange Rates'],['printing','Printing']] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`min-h-11 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${tab === id ? 'bg-[#0c1c35] text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>{label}</button>)}
        </div>

        {tab === 'company' && (
          <div className="space-y-4">
            <SettingsCard title="Company Identity"><div className="grid md:grid-cols-2 gap-3"><Field label="Company Name"><input value={form.companyName} onChange={event => setForm(current => ({ ...current, companyName: event.target.value }))} className="form-input" /></Field><Field label="Business Type"><input value={form.businessType} onChange={event => setForm(current => ({ ...current, businessType: event.target.value }))} className="form-input" /></Field><Field label="Phone"><input type="tel" value={form.phone} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} className="form-input" /></Field><Field label="Email"><input type="email" value={form.email} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} className="form-input" /></Field><Field label="Website"><input value={form.website} onChange={event => setForm(current => ({ ...current, website: event.target.value }))} className="form-input" /></Field><Field label="Office Address"><input value={form.address} onChange={event => setForm(current => ({ ...current, address: event.target.value }))} className="form-input" /></Field></div></SettingsCard>
            <SettingsCard title="Routes & Financial Defaults"><div className="grid md:grid-cols-2 gap-3"><Field label="Default Origin"><input value={form.defaultOrigin} onChange={event => setForm(current => ({ ...current, defaultOrigin: event.target.value }))} className="form-input" /></Field><Field label="Destination Country"><input value={form.defaultDestinationCountry} onChange={event => setForm(current => ({ ...current, defaultDestinationCountry: event.target.value }))} className="form-input" /></Field><Field label="Default Currency"><select value={form.defaultCurrency} onChange={event => setForm(current => ({ ...current, defaultCurrency: event.target.value as typeof form.defaultCurrency }))} className="form-input"><option>USD</option><option>TZS</option><option>AED</option></select></Field><Field label="Exchange Rate Policy"><select value={form.exchangeRatePolicy} onChange={event => setForm(current => ({ ...current, exchangeRatePolicy: event.target.value as typeof form.exchangeRatePolicy }))} className="form-input"><option value="REQUIRE_TODAY">Require today's exact rate</option><option value="LATEST_APPROVED">Use latest approved rate</option></select></Field><Field label="Tax ID"><input value={form.taxId} onChange={event => setForm(current => ({ ...current, taxId: event.target.value }))} className="form-input" /></Field><Field label="Bank Name"><input value={form.bankName} onChange={event => setForm(current => ({ ...current, bankName: event.target.value }))} className="form-input" /></Field><Field label="Bank Account"><input value={form.bankAccount} onChange={event => setForm(current => ({ ...current, bankAccount: event.target.value }))} className="form-input" /></Field><Field label="Account Name"><input value={form.bankAccountName} onChange={event => setForm(current => ({ ...current, bankAccountName: event.target.value }))} className="form-input" /></Field><Field label="Bank SWIFT"><input value={form.bankSwift} onChange={event => setForm(current => ({ ...current, bankSwift: event.target.value }))} className="form-input" /></Field></div></SettingsCard>
            <SettingsCard title="Terms & Conditions"><textarea value={form.termsAndConditions} onChange={event => setForm(current => ({ ...current, termsAndConditions: event.target.value }))} rows={4} className="form-input resize-none" /></SettingsCard>
            <button disabled={saving} onClick={saveCompany} className="primary-button">Save Company Settings</button>
          </div>
        )}

        {tab === 'shipping' && (
          <div className="space-y-5">
            <div className="grid md:grid-cols-2 gap-4">
              {(['Air Cargo','Sea Cargo'] as ShipmentType[]).map(method => {
                const current = activeRate(method)
                const unit = method === 'Air Cargo' ? 'KG' : 'CBM'
                return <SettingsCard key={method} title={method.toUpperCase()}><div className="rounded-xl bg-slate-50 p-4 mb-4"><div className="text-xs text-slate-500">Current Rate</div><div className="text-xl font-bold text-slate-800">{current ? `USD ${current.rate} / ${unit}` : 'Not configured'}</div>{current && <div className="text-xs text-slate-500 mt-2">Effective {current.effectiveFrom} · Updated by {displayUser(current.updatedBy)}</div>}</div><Field label={`New USD Rate / ${unit}`}><input type="number" min="0" step="0.000001" value={method === 'Air Cargo' ? shippingForm.air : shippingForm.sea} onChange={event => setShippingForm(value => ({ ...value, [method === 'Air Cargo' ? 'air' : 'sea']: event.target.value }))} className="form-input" /></Field><Field label="Effective From"><input type="date" value={shippingForm.effectiveFrom} onChange={event => setShippingForm(value => ({ ...value, effectiveFrom: event.target.value }))} className="form-input" /></Field><button disabled={saving} onClick={() => saveCargoRate(method)} className="primary-button mt-3">Save {method} Rate</button></SettingsCard>
              })}
            </div>
            <SettingsCard title="Shipping Rate History"><HistoryTable headers={['Effective','Method','Rate','Unit','Status','Updated By']} rows={shippingRates.map(rate => [rate.effectiveFrom, rate.shippingMethod, `USD ${rate.rate}`, rate.pricingUnit, rate.isActive ? 'Active' : 'Inactive', displayUser(rate.updatedBy)])} /></SettingsCard>
          </div>
        )}

        {tab === 'exchange' && (
          <div className="space-y-5">
            <SettingsCard title="Today's Exchange Rates"><div className="grid md:grid-cols-2 gap-3"><Field label="Rate Date"><input type="date" value={fxForm.rateDate} onChange={event => setFxForm(current => ({ ...current, rateDate: event.target.value }))} className="form-input" /></Field><Field label="Source"><select value={fxForm.source} onChange={event => setFxForm(current => ({ ...current, source: event.target.value as ExchangeRateSource }))} className="form-input"><option>MANUAL</option><option>OVERRIDE</option><option>API</option></select></Field><Field label="1 USD = TZS"><input type="number" min="0" step="0.000001" value={fxForm.usdToTzs} onChange={event => setFxForm(current => ({ ...current, usdToTzs: event.target.value }))} className="form-input" /></Field><Field label="1 USD = AED"><input type="number" min="0" step="0.000001" value={fxForm.usdToAed} onChange={event => setFxForm(current => ({ ...current, usdToAed: event.target.value }))} className="form-input" /></Field><Field className="md:col-span-2" label="Source / Notes"><input value={fxForm.notes} onChange={event => setFxForm(current => ({ ...current, notes: event.target.value }))} className="form-input" /></Field></div><button disabled={saving} onClick={saveFx} className="primary-button mt-4">Save Today's Rates</button></SettingsCard>
            <SettingsCard title="Daily Exchange Rate History"><HistoryTable headers={['Date','USD/TZS','USD/AED','Source','Updated By','Updated']} rows={exchangeRates.map(rate => [rate.rateDate, String(rate.usdToTzs), String(rate.usdToAed), rate.source, displayUser(rate.updatedBy), new Date(rate.updatedAt).toLocaleString()])} /></SettingsCard>
          </div>
        )}

        {tab === 'printing' && (
          <div className="space-y-4">
            <SettingsCard title="Item QR Sticker Printing">
              <div className="max-w-md">
                <Field label="Default Item Sticker Size">
                  <select value={form.defaultItemStickerSize} onChange={event => setForm(current => ({ ...current, defaultItemStickerSize: event.target.value as ItemStickerSize }))} className="form-input">
                    <option value="50x30">50mm x 30mm</option>
                    <option value="60x40">60mm x 40mm</option>
                    <option value="100x50">100mm x 50mm</option>
                  </select>
                </Field>
                <p className="mt-2 text-xs text-slate-500">Used by Print Sticker and Print All Item Stickers. Labels print in black and white with minimal margins.</p>
                <button disabled={saving} onClick={saveCompany} className="primary-button mt-4">Save Printing Settings</button>
              </div>
            </SettingsCard>
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="section-surface"><h2 className="border-b bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 sm:px-5">{title}</h2><div className="p-4 sm:p-5">{children}</div></section> }
function Field({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) { return <label className={`block ${className}`}><span className="form-label">{label}</span>{children}</label> }
function HistoryTable({ headers, rows }: { headers: string[]; rows: string[][] }) { return <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{headers.map(header => <th key={header} className="text-left px-3 py-2 text-xs text-slate-500 border-b">{header}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={`${row[0]}-${index}`} className="border-b last:border-0">{row.map((value, column) => <td key={`${column}-${value}`} className="px-3 py-2 whitespace-nowrap">{value}</td>)}</tr>) : <tr><td colSpan={headers.length} className="text-center py-8 text-slate-400">No rate history yet.</td></tr>}</tbody></table></div> }
