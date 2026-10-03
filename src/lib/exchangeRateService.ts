import type { ExchangeRate, ExchangeRatePolicy } from '../types'

export interface ApplicableExchangeRate {
  rate: ExchangeRate
  isCarryForward: boolean
}

export function findApplicableExchangeRate(
  rates: ExchangeRate[],
  requestedDate: string,
  policy: ExchangeRatePolicy,
): ApplicableExchangeRate | null {
  const approved = [...rates]
    .filter(rate => rate.baseCurrency === 'USD' && rate.rateDate <= requestedDate)
    .sort((a, b) => b.rateDate.localeCompare(a.rateDate))
  const exact = approved.find(rate => rate.rateDate === requestedDate)
  if (exact) return { rate: exact, isCarryForward: false }
  if (policy === 'LATEST_APPROVED' && approved[0]) {
    return { rate: approved[0], isCarryForward: true }
  }
  return null
}
