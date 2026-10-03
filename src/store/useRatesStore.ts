import { create } from 'zustand'
import { supabase } from '../lib/supabase'
import type { ExchangeRate, ExchangeRateSource, ShippingRate, ShipmentType } from '../types'

function mapShippingRate(row: any): ShippingRate {
  return {
    id: row.id,
    shippingMethod: row.shipping_method,
    currency: 'USD',
    pricingUnit: row.pricing_unit,
    rate: Number(row.rate),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to ?? undefined,
    isActive: row.is_active,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapExchangeRate(row: any): ExchangeRate {
  return {
    id: row.id,
    rateDate: row.rate_date,
    baseCurrency: 'USD',
    usdToTzs: Number(row.usd_to_tzs),
    usdToAed: Number(row.usd_to_aed),
    source: row.source,
    notes: row.notes ?? undefined,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface RatesState {
  loaded: boolean
  shippingRates: ShippingRate[]
  exchangeRates: ExchangeRate[]
  loadRates: () => Promise<void>
  getShippingRate: (method: ShipmentType, date?: string) => ShippingRate | undefined
  saveShippingRate: (method: ShipmentType, rate: string, effectiveFrom: string) => Promise<void>
  saveExchangeRate: (data: {
    rateDate: string
    usdToTzs: string
    usdToAed: string
    source: ExchangeRateSource
    notes?: string
    userId: string
  }) => Promise<void>
}

export const useRatesStore = create<RatesState>()((set, get) => ({
  loaded: false,
  shippingRates: [],
  exchangeRates: [],

  loadRates: async () => {
    const [shipping, exchange] = await Promise.all([
      supabase.from('shipping_rates').select('*').order('effective_from', { ascending: false }),
      supabase.from('exchange_rates').select('*').order('rate_date', { ascending: false }),
    ])
    if (shipping.error) throw new Error(`Shipping rates could not be loaded: ${shipping.error.message}`)
    if (exchange.error) throw new Error(`Exchange rates could not be loaded: ${exchange.error.message}`)
    set({
      loaded: true,
      shippingRates: (shipping.data ?? []).map(mapShippingRate),
      exchangeRates: (exchange.data ?? []).map(mapExchangeRate),
    })
  },

  getShippingRate: (method, date = new Date().toISOString().slice(0, 10)) =>
    get().shippingRates.find(rate =>
      rate.shippingMethod === method &&
      rate.isActive &&
      rate.effectiveFrom <= date &&
      (!rate.effectiveTo || rate.effectiveTo >= date)
    ),

  saveShippingRate: async (method, rate, effectiveFrom) => {
    const { error } = await supabase.rpc('set_shipping_rate', {
      p_shipping_method: method,
      p_rate: rate,
      p_effective_from: effectiveFrom,
    })
    if (error) throw new Error(error.message)
    await get().loadRates()
  },

  saveExchangeRate: async data => {
    const existing = get().exchangeRates.find(rate => rate.rateDate === data.rateDate)
    const payload: Record<string, unknown> = {
      rate_date: data.rateDate,
      base_currency: 'USD',
      usd_to_tzs: data.usdToTzs,
      usd_to_aed: data.usdToAed,
      source: data.source,
      notes: data.notes || null,
      updated_by: data.userId,
      updated_at: new Date().toISOString(),
    }
    if (existing) {
      payload.id = existing.id
      payload.created_by = existing.createdBy || data.userId
      payload.created_at = existing.createdAt
    } else {
      payload.created_by = data.userId
    }
    const { error } = await supabase
      .from('exchange_rates')
      .upsert(payload, { onConflict: 'rate_date,base_currency' })
    if (error) throw new Error(error.message)
    await get().loadRates()
  },
}))
