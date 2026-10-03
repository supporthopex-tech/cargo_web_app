import type { Currency } from '../types'

type DecimalInput = string | number

function plainDecimal(value: DecimalInput): string {
  const text = String(value).trim()
  if (!/[eE]/.test(text)) return text
  if (!Number.isFinite(Number(text))) throw new Error('Invalid decimal value.')
  return Number(text).toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
}

function scaled(value: DecimalInput, scale: number): bigint {
  const text = plainDecimal(value)
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid decimal value: ${text}`)
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fraction = ''] = unsigned.split('.')
  const kept = fraction.slice(0, scale).padEnd(scale, '0')
  const next = Number(fraction[scale] || '0')
  let result = BigInt(`${whole}${kept}` || '0')
  if (next >= 5) result += 1n
  return negative ? -result : result
}

function rescale(value: bigint, fromScale: number, toScale: number): bigint {
  if (fromScale === toScale) return value
  if (fromScale < toScale) return value * 10n ** BigInt(toScale - fromScale)
  const divisor = 10n ** BigInt(fromScale - toScale)
  const quotient = value / divisor
  const remainder = value % divisor
  return quotient + (remainder * 2n >= divisor ? 1n : 0n)
}

function asDecimal(value: bigint, scale: number): string {
  const negative = value < 0
  const absolute = negative ? -value : value
  if (scale === 0) return `${negative ? '-' : ''}${absolute}`
  const raw = absolute.toString().padStart(scale + 1, '0')
  const point = raw.length - scale
  return `${negative ? '-' : ''}${raw.slice(0, point)}.${raw.slice(point)}`
}

export function multiplyDecimal(
  left: DecimalInput,
  right: DecimalInput,
  resultScale = 2,
  inputScale = 6,
): string {
  const product = scaled(left, inputScale) * scaled(right, inputScale)
  return asDecimal(rescale(product, inputScale * 2, resultScale), resultScale)
}

export function calculateBaseAmount(measurement: DecimalInput, rateUsd: DecimalInput): string {
  return multiplyDecimal(measurement, rateUsd, 2, 6)
}

export function convertUsd(
  baseAmountUsd: DecimalInput,
  exchangeRate: DecimalInput,
  targetCurrency: Currency,
): string {
  const scale = targetCurrency === 'TZS' ? 0 : 2
  return multiplyDecimal(baseAmountUsd, exchangeRate, scale, 6)
}

export function invoiceAmountFor(
  baseAmountUsd: DecimalInput,
  currency: Currency,
  usdToTzs?: DecimalInput,
  usdToAed?: DecimalInput,
): string {
  if (currency === 'USD') return multiplyDecimal(baseAmountUsd, 1, 2, 6)
  const rate = currency === 'TZS' ? usdToTzs : usdToAed
  if (rate === undefined || Number(rate) <= 0) {
    throw new Error(`An exchange rate for ${currency} is not available.`)
  }
  return convertUsd(baseAmountUsd, rate, currency)
}

export function calculateCbm(
  lengthCm: DecimalInput,
  widthCm: DecimalInput,
  heightCm: DecimalInput,
  packages: DecimalInput,
): string {
  const values = [lengthCm, widthCm, heightCm, packages].map(Number)
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return '0.0000'
  return ((values[0] * values[1] * values[2] * values[3]) / 1_000_000).toFixed(4)
}

export function asDatabaseDecimal(value: DecimalInput, scale: number): string {
  return asDecimal(scaled(value, scale), scale)
}
